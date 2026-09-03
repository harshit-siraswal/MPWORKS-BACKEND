import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeImage } from '../src/image-analysis.js';

const SOURCE_URL = process.env.MPLADS_SOURCE_URL || 'https://mplads.gov.in/MPLADS/AuthenticatedPages/Reports/Citizen/rptCitizenWorkRegister.aspx';
const outputDir = join(process.cwd(), 'data', 'raw', 'mplads');
const evidenceDir = join(process.cwd(), 'data', 'evidence', 'mplads');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const maxStates = Number(process.env.MPLADS_MAX_STATES || 0);

const selectors = {
  house: '#body_ddlHouse',
  tenure: '#body_ddlTenure',
  state: '#body_ddlState',
  location: '#body_ddlLocation',
  status: '#body_ddlStatus',
  search: '#body_btnSearch',
  excel: '#body_btnExcel'
};

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function safeName(value) { return clean(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90) || 'all'; }

function imagePayloads(value, found = []) {
  if (!value) return found;
  if (typeof value === 'string') {
    const dataUrl = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (dataUrl) found.push({ mimeType: dataUrl[1], base64: dataUrl[2] });
    else if (/^[a-z0-9+/=\r\n]{200,}$/i.test(value) && value.length % 4 === 0) found.push({ mimeType: 'image/unknown', base64: value.replace(/\s/g, '') });
    return found;
  }
  if (typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    if (/(image|photo|file|content|data|document|attachment)/i.test(key)) imagePayloads(item, found);
    else if (item && typeof item === 'object') imagePayloads(item, found);
  }
  return found;
}

function extensionFor(mimeType) { return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[mimeType] || 'bin'; }

function absoluteUrl(value, pageUrl) {
  try { return new URL(value, pageUrl).toString(); } catch { return null; }
}

function findAttachmentIds(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    if (/(attachment|file|image|photo)/i.test(key) && (typeof item === 'string' || typeof item === 'number')) found.add(String(item));
    if (item && typeof item === 'object') findAttachmentIds(item, found);
  }
  return found;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  return response.json();
}

async function collectEvidence(page, filename) {
  const candidates = await page.locator('a, tr').evaluateAll((nodes) => nodes.map((node) => ({
    text: node.textContent?.trim(), href: node.href || null,
    attrs: Object.fromEntries([...node.attributes].map((attr) => [attr.name, attr.value]))
  })).filter((item) => Object.keys(item.attrs).some((key) => /work.?id|wrk.?rec|file.?status|flag/i.test(key)) || /image/i.test(item.text || '')));
  const evidence = { candidates, reviews: [], attachments: [], images: [], fetchedAt: new Date().toISOString() };
  await mkdir(evidenceDir, { recursive: true });
  const sourceOrigin = new URL(page.url()).origin;
  for (const candidate of candidates.slice(0, 200)) {
    const reviewPayload = { ...candidate.attrs };
    try {
      const review = await postJson(`${sourceOrigin}/rest/PreLoginCitizenWorkRcmdRest/getReviewDetailsByWork`, { json: reviewPayload });
      evidence.reviews.push({ candidate, response: review });
      for (const id of findAttachmentIds(review)) {
        try {
          const response = await postJson(`${sourceOrigin}/rest/PreLoginCitizenWorkRcmdRest/getAttachmentById`, { id });
          evidence.attachments.push({ id, response });
          for (const [imageIndex, payload] of imagePayloads(response).entries()) {
            try {
              const buffer = Buffer.from(payload.base64, 'base64');
              const file = `${safeName(filename)}-${safeName(id)}-${imageIndex}.${extensionFor(payload.mimeType)}`;
              await writeFile(join(evidenceDir, file), buffer);
              evidence.images.push({ file: join('data', 'evidence', 'mplads', file), ...(await analyzeImage(buffer, `${sourceOrigin}/attachment/${id}`)) });
            } catch (imageError) { evidence.images.push({ id, error: imageError.message }); }
          }
        } catch (error) { evidence.attachments.push({ id, error: error.message }); }
      }
    } catch (error) { evidence.reviews.push({ candidate, error: error.message }); }
  }
  await writeFile(join(outputDir, `${filename}.evidence.json`), JSON.stringify(evidence, null, 2), 'utf8');
  return { candidateCount: candidates.length, reviewCount: evidence.reviews.length, attachmentCount: evidence.attachments.length };
}

async function options(page, selector) {
  return page.locator(`${selector} option`).evaluateAll((items) => items.map((item) => ({ value: item.value, label: item.textContent.trim() })).filter((item) => item.value && item.value !== '0'));
}

async function selectIfPresent(page, selector, value) {
  if (await page.locator(selector).count()) await page.selectOption(selector, value);
}

if (dryRun) {
  console.log(JSON.stringify({ sourceUrl: SOURCE_URL, selectors, outputDir, mode: 'dry-run', note: 'A real run uses Playwright to read the official dropdowns and downloads the returned work-register exports.' }, null, 2));
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run npm install, then retry npm run fetch:mplads.');
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const manifest = { sourceUrl: SOURCE_URL, fetchedAt: new Date().toISOString(), selectors, records: [], errors: [] };

try {
  await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const houses = await options(page, selectors.house);
  const selectedHouses = houses.length ? houses : [{ value: '', label: 'page-default' }];
  for (const house of selectedHouses) {
    await selectIfPresent(page, selectors.house, house.value);
    const tenures = await options(page, selectors.tenure);
    const selectedTenures = tenures.length ? tenures : [{ value: '', label: 'page-default' }];
    for (const tenure of selectedTenures) {
      await selectIfPresent(page, selectors.tenure, tenure.value);
      const states = await options(page, selectors.state);
      const selectedStates = (maxStates ? states.slice(0, maxStates) : states).length ? (maxStates ? states.slice(0, maxStates) : states) : [{ value: '', label: 'all-states' }];
      for (const state of selectedStates) {
        await selectIfPresent(page, selectors.state, state.value);
        const locations = await options(page, selectors.location);
        const selectedLocations = locations.length ? locations : [{ value: '', label: 'all-locations' }];
        for (const location of selectedLocations) {
          await selectIfPresent(page, selectors.location, location.value);
          const filename = `MPLADS-${safeName(house.label)}-${safeName(tenure.label)}-${safeName(state.label)}-${safeName(location.label)}`;
          try {
            await page.locator(selectors.search).click();
            await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
            const table = await page.locator('table').first().evaluate((node) => node?.outerHTML || '');
            if (table) await writeFile(join(outputDir, `${filename}.html`), table, 'utf8');
            const evidence = await collectEvidence(page, filename);
            if (await page.locator(selectors.excel).count()) {
              const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
              await page.locator(selectors.excel).click();
              const download = await downloadPromise;
              if (download) await download.saveAs(join(outputDir, `${filename}.xls`));
            }
            manifest.records.push({ house: house.label, tenure: tenure.label, state: state.label, location: location.label, file: filename, evidence });
          } catch (error) {
            manifest.errors.push({ house: house.label, tenure: tenure.label, state: state.label, location: location.label, error: error.message });
          }
        }
      }
    }
  }
} catch (error) {
  manifest.errors.push({ scope: 'navigation', error: error.message });
} finally {
  await browser.close();
}

await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
if (manifest.errors.some((item) => item.scope === 'navigation')) process.exitCode = 2;
console.log(JSON.stringify({ ...manifest, outputDir }, null, 2));
