const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE_URL = 'https://www.ilirh.in';
const FALLBACK_IMAGE = `${SITE_URL}/images/ilirh-website-logo.jpg`;

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugifyArticleTitle(title) {
  return String(title || 'article')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''"]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'article';
}

function articleSlug(article) {
  return `${slugifyArticleTitle(article.title)}-${article.id}`;
}

function articleUrl(article) {
  return `${SITE_URL}/articles/${articleSlug(article)}/`;
}

function descriptionFor(article) {
  const source = text(article.excerpt) || text(article.title);
  return source.length > 158 ? source.slice(0, 155).replace(/\s+\S*$/, '') + '...' : source;
}

function absoluteImage(article) {
  return article.article_image_url ||
    ((article.file_type || '').startsWith('image/') ? article.file_url : '') ||
    FALLBACK_IMAGE;
}

function replaceTag(html, pattern, replacement) {
  return html.replace(pattern, replacement);
}

function metadataHtml(article) {
  const title = `${text(article.title)} - ILIRH`;
  const desc = descriptionFor(article);
  const url = articleUrl(article);
  const image = absoluteImage(article);
  const published = article.created_at || new Date().toISOString();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: text(article.title),
    description: desc,
    image: [image],
    datePublished: published,
    dateModified: published,
    author: { '@type': 'Person', name: text(article.author) },
    publisher: {
      '@type': 'Organization',
      name: 'The International Legal Inteligencia Research Herald, India',
      logo: { '@type': 'ImageObject', url: FALLBACK_IMAGE }
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    articleSection: text(article.category)
  };

  return {
    title,
    desc,
    url,
    image,
    jsonLd: `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
  };
}

function applyArticleMetadata(template, article) {
  const meta = metadataHtml(article);
  let html = template;
  html = replaceTag(html, /<title>[\s\S]*?<\/title>/i, `<title>${htmlEscape(meta.title)}</title>`);
  html = replaceTag(html, /<meta name="description" content="[^"]*">/i, `<meta name="description" content="${htmlEscape(meta.desc)}">`);
  html = replaceTag(html, /<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${htmlEscape(meta.url)}">`);
  html = replaceTag(html, /<meta property="og:type" content="[^"]*">/i, '<meta property="og:type" content="article">');
  html = replaceTag(html, /<meta property="og:title" content="[^"]*">/i, `<meta property="og:title" content="${htmlEscape(meta.title)}">`);
  html = replaceTag(html, /<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${htmlEscape(meta.desc)}">`);
  html = replaceTag(html, /<meta property="og:url" content="[^"]*">/i, `<meta property="og:url" content="${htmlEscape(meta.url)}">`);
  html = replaceTag(html, /<meta property="og:image" content="[^"]*">/i, `<meta property="og:image" content="${htmlEscape(meta.image)}">`);
  html = replaceTag(html, /<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${htmlEscape(meta.title)}">`);
  html = replaceTag(html, /<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${htmlEscape(meta.desc)}">`);
  html = replaceTag(html, /<meta name="twitter:image" content="[^"]*">/i, `<meta name="twitter:image" content="${htmlEscape(meta.image)}">`);
  html = html.replace('</head>', `${meta.jsonLd}\n</head>`);
  return html;
}

async function fetchArticles(template) {
  const url = (template.match(/const SUPABASE_URL = '([^']+)'/) || [])[1];
  const key = (template.match(/const SUPABASE_KEY = '([^']+)'/) || [])[1];
  if (!url || !key) throw new Error('Could not read Supabase URL/key from index.html');

  const query = [
    'select=id,title,author,category,excerpt,created_at,article_image_url,file_url,file_type',
    'order=created_at.desc',
    'limit=10000'
  ].join('&');
  const res = await fetch(`${url}/rest/v1/articles?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`Supabase article fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function writeSitemap(articles) {
  const urls = [
    { loc: `${SITE_URL}/`, priority: '1.0' },
    ...articles.map((article) => ({
      loc: articleUrl(article),
      lastmod: article.created_at ? new Date(article.created_at).toISOString().slice(0, 10) : undefined,
      priority: '0.8'
    }))
  ];
  const body = urls.map((u) => [
    '  <url>',
    `    <loc>${htmlEscape(u.loc)}</loc>`,
    u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : '',
    `    <priority>${u.priority}</priority>`,
    '  </url>'
  ].filter(Boolean).join('\n')).join('\n');
  await fs.writeFile(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
}

async function writeRobots() {
  await fs.writeFile(path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
}

async function writeFallbackPage(template) {
  await fs.writeFile(path.join(ROOT, '404.html'), template);
}

async function resetGeneratedDir(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(ROOT + path.sep)) {
    throw new Error(`Refusing to clean outside repository: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
  await fs.mkdir(resolved, { recursive: true });
}

async function main() {
  const template = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const articles = await fetchArticles(template);
  const articleRoot = path.join(ROOT, 'articles');
  const legacyArticleRoot = path.join(ROOT, 'article');
  await resetGeneratedDir(articleRoot);
  await resetGeneratedDir(legacyArticleRoot);

  for (const article of articles) {
    const pageHtml = applyArticleMetadata(template, article);
    const dir = path.join(articleRoot, articleSlug(article));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.html'), pageHtml);

    const legacyDir = path.join(legacyArticleRoot, String(article.id));
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'index.html'), pageHtml);
  }

  await writeSitemap(articles);
  await writeRobots();
  await writeFallbackPage(template);
  await fs.writeFile(path.join(ROOT, '.nojekyll'), '');
  console.log(`Generated ${articles.length} slug article pages, legacy article pages, sitemap.xml, robots.txt, 404.html, and .nojekyll`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
