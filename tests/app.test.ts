import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const rootDir = path.resolve(process.cwd());
const appJsCode = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

const sandbox: Record<string, unknown> = {
  globalThis: {},
  Math,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Map,
  Set,
  encodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(appJsCode, sandbox);

const core = sandbox.__SULTAN_MENU_CORE__ as {
  RESTAURANT_CONFIG: {
    whatsappNumber: string;
    currency: string;
    deliveryFee: number;
    freeDeliveryThreshold: number;
    maxItemQty: number;
    maxCartDistinctItems: number;
    menu: Array<{ id: string; name: string; category: string; price: number; featured: boolean }>;
  };
  buildMenuMap: (menu: unknown[]) => Map<string, { id: string; name: string; price: number }>;
  validateWhatsAppNumber: (phone: unknown) => { valid: boolean; sanitized: string; reason: string };
  sanitizeQuantity: (value: unknown, maxQty?: number) => number;
  sanitizeNote: (text: unknown, maxLen?: number) => string;
  sanitizeCartData: (
    raw: unknown,
    menuMap: Map<string, unknown>,
    maxQty?: number,
    maxDistinct?: number
  ) => { items: Record<string, number>; orderType: string; note: string };
  filterMenuItems: (
    menu: unknown[],
    criteria: { category?: string; query?: string; featuredOnly?: boolean }
  ) => Array<{ id: string }>;
  calculateTotals: (
    items: Record<string, number>,
    menuMap: Map<string, { id: string; name: string; price: number }>,
    orderType: string,
    deliveryFee: number,
    freeThreshold: number
  ) => {
    totalCount: number;
    subtotal: number;
    delivery: number;
    grandTotal: number;
    remainingForFreeDelivery: number;
    lines: Array<{ id: string; qty: number; lineTotal: number }>;
  };
  formatArabicItemCount: (count: number) => string;
  buildWhatsAppOrderMessage: (totals: unknown, note: string, config?: unknown) => string;
  buildWhatsAppUrl: (phone: unknown, message: string) => { valid: boolean; url: string; reason: string };
};

const menuMap = core.buildMenuMap(core.RESTAURANT_CONFIG.menu);

test('validateWhatsAppNumber accepts valid international digits and rejects malformed numbers', () => {
  assert.equal(core.validateWhatsAppNumber('966501234567').valid, true);
  assert.equal(core.validateWhatsAppNumber(' 966501234567 ').sanitized, '966501234567');
  assert.equal(core.validateWhatsAppNumber('+966501234567').valid, false);
  assert.equal(core.validateWhatsAppNumber('0501234567').valid, false);
  assert.equal(core.validateWhatsAppNumber('12345').valid, false);
  assert.equal(core.validateWhatsAppNumber('96650abc4567').valid, false);
  assert.equal(core.validateWhatsAppNumber(null).valid, false);
});

test('sanitizeQuantity clamps integers safely and rejects invalid numbers', () => {
  assert.equal(core.sanitizeQuantity(3, 20), 3);
  assert.equal(core.sanitizeQuantity(999, 20), 20);
  assert.equal(core.sanitizeQuantity(2.9, 20), 2);
  assert.equal(core.sanitizeQuantity(-5, 20), 0);
  assert.equal(core.sanitizeQuantity(NaN, 20), 0);
  assert.equal(core.sanitizeQuantity(Infinity, 20), 0);
  assert.equal(core.sanitizeQuantity('5', 20), 0);
});

test('sanitizeCartData discards unknown IDs, negative quantities, and prototype pollution keys', () => {
  const poisoned = JSON.parse(
    '{"items":{"charcoal-lamb-chops":2,"unknown-dish":5,"sultan-lamb-kebab":-3,"__proto__":9,"constructor":4,"shish-tawook-gold":99},"orderType":"invalid","note":"بدون بصل\\u0000"}'
  );
  const clean = core.sanitizeCartData(poisoned, menuMap, 20, 30);

  assert.equal(clean.items['charcoal-lamb-chops'], 2);
  assert.equal(clean.items['shish-tawook-gold'], 20);
  assert.equal('unknown-dish' in clean.items, false);
  assert.equal('sultan-lamb-kebab' in clean.items, false);
  assert.equal(Object.prototype.hasOwnProperty.call(clean.items, '__proto__'), false);
  assert.equal(clean.orderType, 'delivery');
  assert.equal(clean.note, 'بدون بصل');
});

test('filterMenuItems filters instantaneously by category, featured flag, and Arabic text normalization', () => {
  const grills = core.filterMenuItems(core.RESTAURANT_CONFIG.menu, { category: 'grills' });
  assert.equal(grills.length, 4);

  const searchChops = core.filterMenuItems(core.RESTAURANT_CONFIG.menu, {
    category: 'all',
    query: 'ريش',
  });
  assert.equal(searchChops.some((i) => i.id === 'charcoal-lamb-chops'), true);

  const featuredOnly = core.filterMenuItems(core.RESTAURANT_CONFIG.menu, {
    category: 'all',
    featuredOnly: true,
  });
  assert.equal(featuredOnly.length > 0, true);
  assert.equal(featuredOnly.length < core.RESTAURANT_CONFIG.menu.length, true);
});

test('calculateTotals computes subtotal, delivery fee, free delivery threshold, and pickup correctly', () => {
  const underThreshold = core.calculateTotals(
    { 'sultan-lamb-kebab': 2 },
    menuMap,
    'delivery',
    15,
    150
  );
  assert.equal(underThreshold.totalCount, 2);
  assert.equal(underThreshold.subtotal, 128);
  assert.equal(underThreshold.delivery, 15);
  assert.equal(underThreshold.grandTotal, 143);
  assert.equal(underThreshold.remainingForFreeDelivery, 22);

  const overThreshold = core.calculateTotals(
    { 'sultan-royal-platter': 1 },
    menuMap,
    'delivery',
    15,
    150
  );
  assert.equal(overThreshold.subtotal, 165);
  assert.equal(overThreshold.delivery, 0);
  assert.equal(overThreshold.grandTotal, 165);
  assert.equal(overThreshold.remainingForFreeDelivery, 0);

  const pickup = core.calculateTotals(
    { 'sultan-lamb-kebab': 1 },
    menuMap,
    'pickup',
    15,
    150
  );
  assert.equal(pickup.delivery, 0);
  assert.equal(pickup.grandTotal, 64);
});

test('buildWhatsAppUrl encodes order details safely and enforces https://wa.me/', () => {
  const totals = core.calculateTotals(
    { 'charcoal-lamb-chops': 1, 'fresh-mint-lemonade': 2 },
    menuMap,
    'delivery',
    15,
    150
  );
  const message = core.buildWhatsAppOrderMessage(totals, 'بدون مخلل', core.RESTAURANT_CONFIG);
  assert.match(message, /ريش ضاني على الفحم × 1/);
  assert.match(message, /بدون مخلل/);

  const urlRes = core.buildWhatsAppUrl(core.RESTAURANT_CONFIG.whatsappNumber, message);
  assert.equal(urlRes.valid, true);
  assert.equal(urlRes.url.startsWith(`https://wa.me/${core.RESTAURANT_CONFIG.whatsappNumber}?text=`), true);
});

test('security invariants: zero innerHTML, strict CSP, RTL Arabic attributes, noopener, relative paths', () => {
  assert.equal(/\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b/.test(appJsCode), false);
  assert.match(indexHtml, /<html\s+lang="ar"\s+dir="rtl">/);
  assert.match(indexHtml, /http-equiv="Content-Security-Policy"/);
  assert.match(indexHtml, /href="css\/style\.css"/);
  assert.match(indexHtml, /src="js\/app\.js"/);
  assert.match(indexHtml, /rel="noopener noreferrer"/);
  assert.equal(/\sstyle=/.test(indexHtml), false);
});

test('formatArabicItemCount follows proper Arabic singular, dual, plural, and 11+ rules', () => {
  assert.equal(core.formatArabicItemCount(0), 'لا توجد أصناف');
  assert.equal(core.formatArabicItemCount(1), 'صنف واحد');
  assert.equal(core.formatArabicItemCount(2), 'صنفان');
  assert.equal(core.formatArabicItemCount(4), '4 أصناف');
  assert.equal(core.formatArabicItemCount(12), '12 صنفاً');
});

function existsExactCase(baseDir: string, relPath: string): boolean {
  const cleanRel = relPath.split(/[?#]/)[0];
  if (!cleanRel || cleanRel === './' || cleanRel === '.') {
    return true;
  }
  const normalized = cleanRel.replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  let current = baseDir;
  for (const part of parts) {
    if (!fs.existsSync(current)) {
      return false;
    }
    const entries = fs.readdirSync(current);
    if (!entries.includes(part)) {
      return false;
    }
    current = path.join(current, part);
  }
  return fs.existsSync(current);
}

function extractLocalRefsFromHtml(html: string): string[] {
  const refs: string[] = [];
  const regex = /\b(?:href|src)="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const val = match[1].trim();
    if (
      !val ||
      val.startsWith('#') ||
      val.startsWith('http://') ||
      val.startsWith('https://') ||
      val.startsWith('mailto:') ||
      val.startsWith('tel:') ||
      val.startsWith('data:')
    ) {
      continue;
    }
    refs.push(val);
  }
  return refs;
}

test('GitHub Pages readiness: all HTML, CSS, JS, and menu asset paths are strictly relative and exist with exact case', () => {
  assert.equal(fs.existsSync(path.join(rootDir, '.nojekyll')), true, '.nojekyll must exist at repo root');
  assert.equal(fs.existsSync(path.join(rootDir, '404.html')), true, '404.html must exist at repo root');

  const html404 = fs.readFileSync(path.join(rootDir, '404.html'), 'utf8');
  const cssCode = fs.readFileSync(path.join(rootDir, 'css/style.css'), 'utf8');
  const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');

  const indexRefs = extractLocalRefsFromHtml(indexHtml);
  const notFoundRefs = extractLocalRefsFromHtml(html404);
  assert.ok(indexRefs.includes('css/style.css'));
  assert.ok(indexRefs.includes('js/app.js'));
  assert.ok(indexRefs.includes('assets/favicon.svg'));
  assert.ok(notFoundRefs.includes('css/style.css'));
  assert.ok(notFoundRefs.includes('assets/favicon.svg'));

  const allHtmlRefs = [...indexRefs, ...notFoundRefs];
  for (const ref of allHtmlRefs) {
    assert.equal(ref.startsWith('/'), false, `HTML ref must be relative, got: ${ref}`);
    assert.equal(existsExactCase(rootDir, ref), true, `Missing or wrong-case file for HTML ref: ${ref}`);
  }

  // Check CSS url(...) references if any exist
  const cssUrlRegex = /url\((['"]?)([^'")]+)\1\)/g;
  let cssMatch: RegExpExecArray | null;
  while ((cssMatch = cssUrlRegex.exec(cssCode)) !== null) {
    const cssRef = cssMatch[2].trim();
    if (cssRef.startsWith('http://') || cssRef.startsWith('https://') || cssRef.startsWith('data:')) {
      continue;
    }
    assert.equal(cssRef.startsWith('/'), false, `CSS url() must be relative, got: ${cssRef}`);
    assert.equal(
      existsExactCase(path.join(rootDir, 'css'), cssRef),
      true,
      `Missing or wrong-case file for CSS ref: ${cssRef}`
    );
  }

  // Check every menu item image in RESTAURANT_CONFIG.menu
  for (const item of core.RESTAURANT_CONFIG.menu) {
    const imgPath = (item as unknown as { image: string }).image;
    assert.equal(typeof imgPath, 'string');
    assert.equal(imgPath.startsWith('/'), false, `Menu image must be relative, got: ${imgPath}`);
    assert.equal(
      existsExactCase(rootDir, imgPath),
      true,
      `Missing or wrong-case menu image: ${imgPath}`
    );
  }

  // Ensure .gitignore never excludes static site folders/files
  const ignoredLines = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  for (const required of ['assets', 'assets/', 'css', 'css/', 'js', 'js/', 'index.html', '404.html', '.nojekyll']) {
    assert.equal(
      ignoredLines.includes(required),
      false,
      `.gitignore must not exclude required static resource: ${required}`
    );
  }
});

