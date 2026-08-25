import OpenAI from 'openai';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const TEMPLATE_PATH = path.join(__dirname, 'template.html');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const HISTORY_DAYS = 6;


// ---------- helpers ----------

const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '');

const decodeEntities = (s) =>
  (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) =>
      String.fromCodePoint(parseInt(d, 10))
    );


const cleanText = (s) =>
  decodeEntities(stripTags(s))
    .replace(/\s+/g, ' ')
    .trim();


const parseInt0 = (s) => {
  const m = String(s ?? '').replace(/[^\d]/g, '');
  return m ? parseInt(m, 10) : 0;
};


async function fetchText(url, attempts = 4) {
  let lastErr;

  for (let i = 0; i < attempts; i++) {

    try {

      const r = await fetch(url, {
        headers: {
          'User-Agent': UA
        }
      });


      if (r.status === 429) {

        const retryAfter =
          parseInt(
            r.headers.get('retry-after') || '0',
            10
          );


        const waitSec =
          Math.max(
            retryAfter,
            30 * (i + 1)
          );


        console.log(
          `429 rate limited ${url}, wait ${waitSec}s`
        );


        await new Promise(
          res => setTimeout(res, waitSec * 1000)
        );


        lastErr = new Error('HTTP 429');
        continue;
      }


      if (!r.ok)
        throw new Error(`HTTP ${r.status}`);


      const text = await r.text();


      if (
        text.length < 20000 &&
        /Too many requests/i.test(text)
      ) {

        const waitSec = 30 * (i + 1);


        console.log(
          `body rate limited ${url}`
        );


        await new Promise(
          res => setTimeout(res, waitSec * 1000)
        );


        lastErr = new Error(
          'Too many requests'
        );

        continue;
      }


      return text;


    } catch (e) {

      lastErr = e;


      if (i < attempts - 1) {

        await new Promise(
          res =>
            setTimeout(
              res,
              2000 * (i + 1)
            )
        );

      }
    }
  }


  throw new Error(
    `fetch failed: ${lastErr?.message}`
  );
}


const sleep = (ms) =>
  new Promise(
    res => setTimeout(res, ms)
  );


// ---------- parsers ----------


function parseTrendingHTML(html) {

  const articles =
    [
      ...html.matchAll(
        /<article class="Box-row">([\s\S]*?)<\/article>/g
      )
    ];


  const repos = [];


  for (const [, a] of articles) {


    const hrefM =
      a.match(
        /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/
      );


    if (!hrefM)
      continue;


    const parts =
      hrefM[1]
        .replace(/^\//, '')
        .split('/');


    if (parts.length < 2)
      continue;


    const [owner, repo] = parts;


    const descM =
      a.match(
        /<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/
      );


    const langM =
      a.match(
        /itemprop="programmingLanguage"[^>]*>([^<]+)/
      );


    const colorM =
      a.match(
        /class="repo-language-color"[^>]*style="background-color:\s*([^";]+)/
      );


    const starsM =
      a.match(
        /href="[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/
      );


    const forksM =
      a.match(
        /href="[^"]+\/forks"[^>]*>([\s\S]*?)<\/a>/
      );


    const todayM =
      a.match(
        /float-sm-right[^"]*"[^>]*>([\s\S]*?)<\/span>/
      );


    repos.push({

      owner,

      repo,

      url:
        `https://github.com/${owner}/${repo}`,

      desc:
        descM
          ? cleanText(descM[1])
          : '',

      lang:
        langM
          ? langM[1].trim()
          : '',

      langColor:
        colorM
          ? colorM[1].trim()
          : '',

      stars:
        parseInt0(
          starsM
            ? cleanText(starsM[1])
            : ''
        ),

      forks:
        parseInt0(
          forksM
            ? cleanText(forksM[1])
            : ''
        ),

      today:
        todayM
          ? cleanText(todayM[1])
          : ''

    });

  }


  return {
    repos,
    count: repos.length
  };

}function parseSearchPayload(html) {

  const m = html.match(
    /<script[^>]+data-target="react-app\.embeddedData"[^>]*>([\s\S]+?)<\/script>/
  );


  if (!m)
    return {
      repos: [],
      count: 0
    };


  let data;


  try {

    data =
      JSON.parse(
        decodeEntities(m[1])
      );

  } catch {

    return {
      repos: [],
      count: 0
    };

  }


  const results =
    data?.payload?.results || [];


  const repos = [];


  for (const r of results) {


    const name =
      cleanText(
        r.hl_name || ''
      );


    if (!name.includes('/'))
      continue;


    const [
      owner,
      repo
    ] = name.split('/');


    repos.push({

      owner,

      repo,

      url:
        `https://github.com/${owner}/${repo}`,

      desc:
        cleanText(
          r.hl_trunc_description || ''
        ),

      lang:
        r.language || '',

      langColor:
        r.color || '',

      stars:
        parseInt(
          r.followers || 0,
          10
        ),

      forks: 0,

      today: ''

    });

  }


  return {
    repos,
    count: repos.length
  };

}


// ---------- Bailian / Qwen translation ----------


function getProviders() {

  if (!process.env.BAILIAN_API_KEY)
    return [];


  return [
    {

      label: 'bailian',

      apiKey:
        process.env.BAILIAN_API_KEY,

      baseUrl:
        process.env.BAILIAN_BASE_URL ||
        'https://dashscope.aliyuncs.com/compatible-mode/v1',

      model:
        process.env.BAILIAN_MODEL ||
        'qwen-plus'

    }
  ];

}


function describeProvider(p) {

  return (
    `${p.label}: ${p.baseUrl} model=${p.model}`
  );

}


const ENRICHMENT_PROMPT_HEADER = [

  '你是 GitHub 仓库的中文增强助手。我会给你 JSON 数组，每条仓库含 owner、repo、desc(原始英文描述)。',

  '请为每条返回 JSON 对象，并最终只返回一个 JSON 数组。',

  '数组长度、顺序必须与输入完全一致。每个对象必须包含以下字段：desc_zh、summary_zh、scenarios、agent_install_prompt。',

  '',

  'desc 字段可能为空字符串，请根据 owner + repo 名合理推断。',

  '不要返回 Markdown，不要解释，只返回 JSON。',

  '',

  'desc_zh：翻译成自然中文。',

  'summary_zh：补充项目用途、实现方式和特点。',

  'scenarios：返回 3-4 个中文使用场景数组。',

  'agent_install_prompt：返回给 AI coding agent 使用的中文安装提示词。',

  '',

  '只返回纯 JSON 数组，不要 ```json 代码块。',

  '',

  '输入：'

].join('\n');
async function callProvider(repos, provider) {

  const client = new OpenAI({

    apiKey:
      provider.apiKey,

    baseURL:
      provider.baseUrl

  });


  const prompt =
    `${ENRICHMENT_PROMPT_HEADER}\n${JSON.stringify(repos)}`;


  let completion;


  for (
    let attempt = 1;
    attempt <= 5;
    attempt++
  ) {


    try {


      completion =
        await client.chat.completions.create({

          model:
            provider.model,


          messages: [

            {

              role: 'user',

              content: prompt

            }

          ],


          temperature: 0.4,


          response_format: {

            type: 'json_object'

          }

        });


      break;


    } catch (e) {


      const status =
        e?.status ||
        e?.statusCode ||
        0;


      const transient =
        status === 429 ||
        (status >= 500 &&
          status < 600) ||
        !status;


      if (
        !transient ||
        attempt === 5
      ) {

        throw e;

      }


      const waitSec =
        Math.min(
          60,
          5 * 2 ** (attempt - 1)
        );


      console.log(

        `    [${provider.label}] ${status || 'network'} on attempt ${attempt}, retrying in ${waitSec}s`

      );


      await new Promise(

        res =>
          setTimeout(
            res,
            waitSec * 1000
          )

      );

    }

  }


  const text =
    completion
      ?.choices?.[0]
      ?.message
      ?.content
      ?.trim();


  if (!text) {

    throw new Error(
      'Bailian returned empty response'
    );

  }


  let arr;


  try {


    let cleaned =
      text
        .replace(
          /^```(?:json)?\s*/i,
          ''
        )
        .replace(
          /\s*```\s*$/i,
          ''
        )
        .trim();


    const parsed =
      JSON.parse(cleaned);


    if (Array.isArray(parsed)) {

      arr = parsed;

    } else {


      arr =
        Object.values(parsed)
          .find(
            v => Array.isArray(v)
          );


    }


  } catch (e) {


    throw new Error(

      `Bailian invalid JSON: ${text.slice(0,300)}`

    );

  }


  if (
    !Array.isArray(arr) ||
    arr.length !== repos.length
  ) {


    throw new Error(

      `Bailian returned ${arr?.length ?? '?'} items, expected ${repos.length}`

    );

  }



  return arr.map(x => ({

    desc_zh:

      typeof x?.desc_zh === 'string'

        ? x.desc_zh

        : '',


    summary_zh:

      typeof x?.summary_zh === 'string'

        ? x.summary_zh

        : '',


    scenarios:

      Array.isArray(x?.scenarios)

        ? x.scenarios
            .map(s => String(s || ''))
            .filter(Boolean)

        : [],



    agent_install_prompt:

      typeof x?.agent_install_prompt === 'string'

        ? x.agent_install_prompt

        : ''

  }));

}



async function translateBatch(
  repos,
  providers
) {


  if (!repos.length)
    return [];


  let lastErr;


  for (
    let i = 0;
    i < providers.length;
    i++
  ) {


    const p =
      providers[i];


    try {


      return await callProvider(
        repos,
        p
      );


    } catch (e) {


      lastErr = e;


      console.log(

        `[${p.label}] failed: ${e.message}`

      );


      if (
        i === providers.length - 1
      ) {

        throw e;

      }


    }

  }


  throw lastErr;

}



async function translateAll(
  repos,
  providers
) {


  const out = [];

  const CHUNK = 10;



  for (
    let i = 0;
    i < repos.length;
    i += CHUNK
  ) {


    const slice =
      repos.slice(
        i,
        i + CHUNK
      );


    const result =
      await translateBatch(
        slice,
        providers
      );


    out.push(
      ...result
    );


    console.log(

      `  enriched chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(repos.length / CHUNK)} (${slice.length} items)`

    );

  }


  return out;

}


// ---------- existing-artifact history ----------


async function loadExistingDatasets() {

  let html;


  try {

    html =
      await fs.readFile(
        INDEX_PATH,
        'utf8'
      );

  } catch {

    return {};

  }


  const stripped =
    html.replace(
      /<!--[\s\S]*?-->/g,
      ''
    );


  const datasets = {};


  const re =
    /<script id="trending-data-(\S+?)" type="application\/json">([\s\S]+?)<\/script>/g;


  let m;


  while (
    (m = re.exec(stripped)) !== null
  ) {


    try {

      datasets[m[1]] =
        JSON.parse(
          m[2]
            .replace(
              /<\\\/script/g,
              '</script'
            )
        );


    } catch {

      console.warn(
        `cannot parse dataset ${m[1]}`
      );

    }

  }


  return datasets;

}



function buildEnrichmentCache(
  existingDatasets
) {

  const cache = {};


  for (
    const ds of Object.values(existingDatasets)
  ) {


    for (
      const r of ds.repos || []
    ) {


      const hasAll =
        r.desc_zh &&
        r.summary_zh &&
        Array.isArray(r.scenarios) &&
        r.scenarios.length &&
        r.agent_install_prompt;


      if (!hasAll)
        continue;


      const key =
        `${r.owner}/${r.repo}|${r.desc || ''}`;


      cache[key] = {

        desc_zh:
          r.desc_zh,

        summary_zh:
          r.summary_zh,

        scenarios:
          r.scenarios,

        agent_install_prompt:
          r.agent_install_prompt

      };

    }

  }


  return cache;

}



function rollHistory(
  existing,
  todayStr
) {


  const today =
    new Date(
      todayStr + 'T00:00:00Z'
    );


  const kept = {};


  for (
    const [
      name,
      data
    ] of Object.entries(existing)
  ) {


    const m =
      name.match(
        /^daily-(\d{4}-\d{2}-\d{2})$/
      );


    if (!m)
      continue;


    const d =
      new Date(
        m[1] + 'T00:00:00Z'
      );


    const ageDays =
      Math.floor(
        (today - d) /
        86400000
      );


    if (
      ageDays >= 1 &&
      ageDays <= HISTORY_DAYS
    ) {

      kept[name] = data;

    }

  }


  return kept;

}



// ---------- main ----------


async function main() {


  const skipTranslation =
    process.env.SKIP_TRANSLATION === '1';


  const providers =
    getProviders();



  if (
    !providers.length &&
    !skipTranslation
  ) {


    console.error(
      'BAILIAN_API_KEY env var is required'
    );


    process.exit(2);

  }



  const today =
    new Date();


  const todayStr =
    today
      .toISOString()
      .slice(0,10);


  const year =
    today.getUTCFullYear();



  console.log(
    `Refreshing for ${todayStr}`
  );



  if (skipTranslation) {


    console.log(
      'translation skipped'
    );


  } else {


    console.log(
      `translation provider:`
    );


    for (
      const p of providers
    ) {

      console.log(
        describeProvider(p)
      );

    }

  }



  console.log(
    'Loading existing artifact...'
  );


  const existing =
    await loadExistingDatasets();



  const dailyRetained =
    rollHistory(
      existing,
      todayStr
    );


  const enrichmentCache = { };



  console.log(
    'Fetching GitHub trending...'
  );



  const [
    dailyHTML,
    weeklyHTML,
    monthlyHTML
  ] =
    await Promise.all([

      fetchText(
        'https://github.com/trending?since=daily'
      ),

      fetchText(
        'https://github.com/trending?since=weekly'
      ),

      fetchText(
        'https://github.com/trending?since=monthly'
      )

    ]);



  const todayDaily =
    parseTrendingHTML(
      dailyHTML
    );


  const weekly =
    parseTrendingHTML(
      weeklyHTML
    );


  const monthly =
    parseTrendingHTML(
      monthlyHTML
    );



  const yearlyPages = [];


  for (
    const p of [1,2,3]
  ) {


    const html =
      await fetchText(
        `https://github.com/search?q=created%3A%3E%3D${year}-01-01&type=repositories&s=stars&o=desc&p=${p}`
      );


    yearlyPages.push(
      parseSearchPayload(
        html
      )
    );


    if (p < 3)
      await sleep(2000);

  }



  const yearlySeen =
    new Set();


  const yearlyRepos = [];



  for (
    const page of yearlyPages
  ) {


    for (
      const r of page.repos
    ) {


      const k =
        `${r.owner}/${r.repo}`;


      if (yearlySeen.has(k))
        continue;


      yearlySeen.add(k);


      yearlyRepos.push(r);

    }

  }



  const yearly = {

    repos:
      yearlyRepos,

    count:
      yearlyRepos.length

  };



  const fresh = {

    [`daily-${todayStr}`]:
      todayDaily,

    weekly,

    monthly,

    yearly

  };



  const seenKeys =
    new Set();


  const todoRepos = [];



  for (
    const ds of Object.values(fresh)
  ) {


    for (
      const r of ds.repos
    ) {


      const key =
        `${r.owner}/${r.repo}|${r.desc || ''}`;


      if (
        seenKeys.has(key)
      )
        continue;


      seenKeys.add(key);



      if (
        !enrichmentCache[key]
      ) {


        todoRepos.push({

          owner:
            r.owner,

          repo:
            r.repo,

          desc:
            r.desc || ''

        });


      }

    }

  }



  if (
    !skipTranslation &&
    todoRepos.length
  ) {


    console.log(
      `Calling Bailian for ${todoRepos.length} repos`
    );


    const translated =
      await translateAll(
        todoRepos,
        providers
      );


    for (
      let i = 0;
      i < todoRepos.length;
      i++
    ) {


      const r =
        todoRepos[i];


      const key =
        `${r.owner}/${r.repo}|${r.desc}`;


      enrichmentCache[key] =
        translated[i];

    }

  }



  for (
    const ds of Object.values(fresh)
  ) {


    for (
      const r of ds.repos
    ) {


      const key =
        `${r.owner}/${r.repo}|${r.desc || ''}`;


      const e =
        enrichmentCache[key];



      r.desc_zh =
        e?.desc_zh || '';

      r.summary_zh =
        e?.summary_zh || '';

      r.scenarios =
        e?.scenarios || [];

      r.agent_install_prompt =
        e?.agent_install_prompt || '';

    }

  }



  const allDatasets = {

    ...dailyRetained,

    ...fresh

  };



  const template =
    await fs.readFile(
      TEMPLATE_PATH,
      'utf8'
    );



  const safeJSON =
    obj =>
      JSON.stringify(obj)
        .replace(
          /<\/script/g,
          '<\\/script'
        );



  const blocks =
    Object.entries(allDatasets)
      .map(
        ([k,v]) =>
          `<script id="trending-data-${k}" type="application/json">${safeJSON(v)}</script>`
      )
      .join('\n');



  const html =
    template
      .replace(
        '__DATASETS__',
        blocks
      )
      .replace(
        '__FETCHED_AT__',
        today.toISOString()
      );



  await fs.writeFile(
    INDEX_PATH,
    html,
    'utf8'
  );



  console.log(
    `Wrote ${INDEX_PATH}`
  );

}



main().catch(err => {

  console.error(
    'BUILD FAILED:',
    err
  );


  process.exit(1);

});