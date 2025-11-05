import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_PATH = path.resolve(__dirname, '../config/mock_moodboard_data.json');
const OUTPUT_DIR = path.resolve(__dirname, '../generated/moodboards');

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MAX_IMAGE_ASSETS = 6;
const IMAGE_COLUMNS = 2;
const IMAGE_MAX_WIDTH = 220;
const IMAGE_MAX_HEIGHT = 160;
const IMAGE_COLUMN_GAP = 40;
const IMAGE_ROW_GAP = 90;
const IMAGE_MARGIN_LEFT = 50;
const IMAGE_PAGE_TOP = PAGE_HEIGHT - 120;
const MAX_IMAGE_BYTES = 1_800_000;

let cachedFixtures = null;

function loadFixtures() {
  if (!cachedFixtures) {
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    cachedFixtures = JSON.parse(raw);
  }
  return cachedFixtures;
}

function ensureOutputDir() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (values || [])
        .map(value => (value ?? '').toString().trim())
        .filter(Boolean)
    )
  );
}

function coalesce(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') {
      return value;
    }
  }
  return null;
}

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'trend';
}

function escapePdfText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r?\n/g, ' ');
}

function composeTextLines(title, sections) {
  const lines = [
    title,
    ''.padStart(title.length, '='),
    ''
  ];

  for (const section of sections) {
    lines.push(section.heading);
    lines.push(''.padStart(section.heading.length, '-'));
    for (const line of section.lines) {
      lines.push(line);
    }
    lines.push('');
  }

  return lines;
}

function createTextStream(lines) {
  const baseY = PAGE_HEIGHT - 52;
  const lineSpacing = 16;

  const commands = [];

  lines.forEach((line, index) => {
    const y = baseY - index * lineSpacing;
    if (y < 30) {
      return;
    }

    commands.push('BT');
    commands.push('/F1 12 Tf');
    commands.push(`50 ${Math.round(y)} Td`);
    commands.push(`(${escapePdfText(line)}) Tj`);
    commands.push('ET');
  });

  return Buffer.from(commands.join('\n'), 'utf-8');
}

function isJpeg(buffer) {
  return buffer && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function parseJpegDimensions(buffer) {
  if (!isJpeg(buffer)) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];

    if (marker === 0xC0 || marker === 0xC2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }

    const blockLength = buffer.readUInt16BE(offset + 2);
    offset += blockLength + 2;
  }

  return null;
}

async function fetchImageBuffer(url) {
  if (!url) {
    return null;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  }
}

function buildImageStream(imageAssets) {
  const commands = [
    'BT',
    '/F1 18 Tf',
    `${IMAGE_MARGIN_LEFT} ${PAGE_HEIGHT - 60} Td`,
    '(Moodboard Visuals) Tj',
    'ET'
  ];

  imageAssets.forEach((asset, index) => {
    const column = index % IMAGE_COLUMNS;
    const row = Math.floor(index / IMAGE_COLUMNS);

    const scale = Math.min(
      IMAGE_MAX_WIDTH / asset.width,
      IMAGE_MAX_HEIGHT / asset.height,
      1
    );

    const displayWidth = Math.max(24, Math.round(asset.width * scale));
    const displayHeight = Math.max(24, Math.round(asset.height * scale));

    const x = IMAGE_MARGIN_LEFT + column * (IMAGE_MAX_WIDTH + IMAGE_COLUMN_GAP);
    const top = IMAGE_PAGE_TOP - row * (IMAGE_MAX_HEIGHT + IMAGE_ROW_GAP);
    const y = Math.max(40, Math.round(top - displayHeight));

    commands.push('q');
    commands.push(`${displayWidth} 0 0 ${displayHeight} ${x} ${y} cm`);
    commands.push(`/${asset.resourceName} Do`);
    commands.push('Q');

    if (asset.caption) {
      commands.push('BT');
      commands.push('/F1 12 Tf');
      commands.push(`${x} ${Math.max(26, y - 16)} Td`);
      commands.push(`(${escapePdfText(asset.caption)}) Tj`);
      commands.push('ET');
    }
  });

  return Buffer.from(commands.join('\n'), 'utf-8');
}

class PdfBuilder {
  constructor() {
    this.objects = [];
  }

  addText(content = '') {
    const object = { type: 'text', content };
    this.objects.push(object);
    return { objectNumber: this.objects.length, index: this.objects.length - 1 };
  }

  setText(index, content) {
    if (this.objects[index]) {
      this.objects[index].content = content;
    }
  }

  addStream(dict = {}, streamBuffer = Buffer.alloc(0)) {
    const object = { type: 'stream', dict, stream: streamBuffer };
    this.objects.push(object);
    return { objectNumber: this.objects.length, index: this.objects.length - 1 };
  }

  build(rootObjectNumber = 1) {
    const header = Buffer.from('%PDF-1.4\n', 'utf-8');
    const buffers = [header];
    const offsets = [];

    let offset = header.length;

    this.objects.forEach((obj, idx) => {
      const objectNumber = idx + 1;
      let buffer;

      if (obj.type === 'text') {
        const body = `${objectNumber} 0 obj\n${obj.content}\nendobj\n`;
        buffer = Buffer.from(body, 'utf-8');
      } else if (obj.type === 'stream') {
        const dict = { ...(obj.dict || {}), Length: obj.stream.length };
        const dictEntries = Object.entries(dict).map(([key, value]) => {
          const mappedValue = typeof value === 'number' ? String(value) : value;
          return `/${key} ${mappedValue}`;
        }).join(' ');
        const dictString = `<< ${dictEntries} >>`;
        const headerStr = `${objectNumber} 0 obj\n${dictString}\nstream\n`;
        const footerStr = '\nendstream\nendobj\n';
        buffer = Buffer.concat([
          Buffer.from(headerStr, 'utf-8'),
          obj.stream,
          Buffer.from(footerStr, 'utf-8')
        ]);
      } else {
        buffer = Buffer.alloc(0);
      }

      offsets.push(offset);
      buffers.push(buffer);
      offset += buffer.length;
    });

    const xrefOffset = offset;
    const xrefEntries = offsets.map(off => off.toString().padStart(10, '0') + ' 00000 n ');
    const xrefString = [
      'xref',
      `0 ${this.objects.length + 1}`,
      '0000000000 65535 f ',
      ...xrefEntries,
      ''
    ].join('\n');

    const trailerString = [
      'trailer',
      `<< /Size ${this.objects.length + 1} /Root ${rootObjectNumber} 0 R >>`,
      'startxref',
      String(xrefOffset),
      '%%EOF\n'
    ].join('\n');

    buffers.push(Buffer.from(xrefString, 'utf-8'));
    buffers.push(Buffer.from(trailerString, 'utf-8'));

    return Buffer.concat(buffers);
  }
}

function buildPdfDocument({ title, sections, imageAssets }) {
  const textLines = composeTextLines(title, sections);
  const textStream = createTextStream(textLines);

  const builder = new PdfBuilder();

  const catalogRef = builder.addText('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesRef = builder.addText('');

  const page1Ref = builder.addText('');
  const content1Ref = builder.addStream({}, textStream);
  const fontRef = builder.addText('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  builder.setText(
    page1Ref.index,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${content1Ref.objectNumber} 0 R /Resources << /Font << /F1 ${fontRef.objectNumber} 0 R >> >> >>`
  );

  let page2Ref = null;
  let content2Ref = null;

  if (imageAssets.length > 0) {
    imageAssets.forEach((asset, idx) => {
      asset.resourceName = `Im${idx + 1}`;
    });

    const imageStream = buildImageStream(imageAssets);
    content2Ref = builder.addStream({}, imageStream);
    page2Ref = builder.addText('');

    imageAssets.forEach(asset => {
      const dict = {
        Type: '/XObject',
        Subtype: '/Image',
        Width: asset.width,
        Height: asset.height,
        ColorSpace: '/DeviceRGB',
        BitsPerComponent: 8,
        Filter: '/DCTDecode'
      };

      const imageRef = builder.addStream(dict, asset.buffer);
      asset.objectNumber = imageRef.objectNumber;
    });

    const resourceParts = [`/Font << /F1 ${fontRef.objectNumber} 0 R >>`];

    if (imageAssets.length > 0) {
      const xObjectEntries = imageAssets
        .map(asset => `/${asset.resourceName} ${asset.objectNumber} 0 R`)
        .join(' ');
      resourceParts.push(`/XObject << ${xObjectEntries} >>`);
    }

    const resourceString = `<< ${resourceParts.join(' ')} >>`;

    builder.setText(
      page2Ref.index,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${content2Ref.objectNumber} 0 R /Resources ${resourceString} >>`
    );
  }

  const kids = [`${page1Ref.objectNumber} 0 R`];
  if (page2Ref) {
    kids.push(`${page2Ref.objectNumber} 0 R`);
  }

  builder.setText(
    pagesRef.index,
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`
  );

  return builder.build(catalogRef.objectNumber);
}

function calculateBrandFitScore(trendScores) {
  if (trendScores.length === 0) {
    return {
      score: 0,
      descriptor: 'Insufficient data'
    };
  }

  const average = trendScores.reduce((acc, entry) => acc + entry.brandFit, 0) / trendScores.length;

  let descriptor = 'Moderate Alignment';
  if (average >= 85) {
    descriptor = 'High Alignment';
  } else if (average >= 70) {
    descriptor = 'Strong Alignment';
  } else if (average < 50) {
    descriptor = 'Low Alignment';
  }

  return {
    score: Math.round(average),
    descriptor
  };
}

function scoreFixtureTrend(trend, raData, brandDNA, weights) {
  const weightKeys = Object.keys(weights);
  const baseScore = weightKeys.reduce((acc, key) => {
    const trendScore = trend.scores?.[key] ?? 0;
    return acc + trendScore * weights[key];
  }, 0);

  const brickOverlap = trend.bricks?.some(brick => raData.bricks?.includes(brick)) ? 10 : 0;
  const colorOverlap = (trend.attributes?.colors || []).filter(color => raData.colors?.includes(color)).length * 3;
  const attributeBonus = (trend.attributes?.patterns || []).filter(pattern => (raData.patterns || []).includes(pattern)).length * 4;

  const dnaColorBonus = brandDNA
    ? (trend.attributes?.colors || []).filter(color => brandDNA.attributeFingerprint?.colorPalette?.includes(color)).length * 2
    : 0;

  const lifecycleBonus = brandDNA?.attributeFingerprint?.lifecycleFilters?.includes(trend.lifecycle) ? 5 : 0;

  const cohortBonus = brandDNA && trend.cohort === brandDNA.cohort ? 8 : 0;

  return baseScore + brickOverlap + colorOverlap + attributeBonus + dnaColorBonus + lifecycleBonus + cohortBonus;
}

export class MoodboardGenerator {
  constructor() {
    this.fixtures = loadFixtures();
  }

  getBrandDNA(brand) {
    return this.fixtures.brand_dna.find(entry => entry.brand.toLowerCase() === brand.toLowerCase());
  }

  getApproachWeights(approach) {
    return this.fixtures.approach_weights[approach] || this.fixtures.approach_weights['cohort-based'];
  }

  normalizeRa(raInput) {
    const attrs = raInput.attributes || {};
    return {
      id: raInput.id,
      brand: raInput.brand || null,
      month: raInput.month || null,
      bricks: uniqueList(raInput.bricks || []),
      colors: uniqueList(raInput.colors || []),
      patterns: uniqueList(attrs.pattern || []),
      fabrics: uniqueList(attrs.fabric || []),
      priceRange: attrs.priceRange || null
    };
  }

  buildBasePayload(raInput, brandDNA, approach) {
    const ra = this.normalizeRa(raInput);
    const dna = brandDNA || null;

    return {
      approach,
      ra,
      brandDNA: dna,
      trends: [],
      rationale: [],
      visualElements: {
        tiles: [],
        palette: uniqueList([
          ...(ra.colors || []),
          ...(dna?.attributeFingerprint?.colorPalette || [])
        ]).slice(0, 12)
      },
      brandAlignment: {
        score: 0,
        descriptor: 'Pending LLM output'
      },
      sources: {
        ra: 'input',
        trends: 'llm'
      }
    };
  }

  getFixtureFallbackTrends(ra, brandDNA, approach) {
    const weights = this.getApproachWeights(approach);
    const scored = (this.fixtures.trend_library || []).map(trend => {
      const score = scoreFixtureTrend(trend, ra, brandDNA, weights);
      const brandFit = trend.scores?.brandAffinity ?? score;
      return {
        ...trend,
        compositeScore: score,
        brandFit
      };
    });

    return scored
      .filter(entry => entry.compositeScore >= 60)
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, 4)
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        lifecycle: entry.lifecycle,
        momentum: entry.momentum,
        image: entry.image,
        attributes: entry.attributes,
        scoreSummary: {
          composite: entry.compositeScore,
          weights: this.getApproachWeights(approach),
          raw: entry.scores
        },
        source: 'fixture',
        brandFit: Math.min(100, Math.max(0, entry.brandFit ?? entry.compositeScore)),
        rationale: [],
        hashtags: entry.hashtags || []
      }));
  }

  createVisualMoodboard(trends, brandDNA, ra) {
    const palette = new Set([
      ...(ra?.colors || []),
      ...(brandDNA?.attributeFingerprint?.colorPalette || [])
    ]);

    const tiles = trends.map(trend => {
      (trend.attributes?.colors || []).forEach(color => palette.add(color));
      return {
        id: trend.id,
        title: trend.name,
        image: trend.image,
        headline: trend.rationale?.[0] || coalesce(
          trend.momentum && `${trend.momentum} momentum`,
          trend.lifecycle && `${trend.lifecycle} stage`,
          'Trend opportunity'
        ),
        attributes: trend.attributes || {
          colors: [],
          patterns: [],
          materials: [],
          silhouettes: []
        },
        hashtags: trend.hashtags || []
      };
    });

    return {
      tiles,
      palette: Array.from(palette).slice(0, 12)
    };
  }

  calculateBrandFit(trends) {
    const fitEntries = trends.map(trend => ({
      id: trend.id,
      name: trend.name,
      brandFit: Math.min(100, Math.max(0, trend.brandFit ?? trend.scoreSummary?.composite ?? 0))
    }));
    return calculateBrandFitScore(fitEntries);
  }

  applyTrendMatrix(payload, trendRows, approach) {
    let rows = trendRows;

    if (!rows || rows.length === 0) {
      rows = this.getFixtureFallbackTrends(payload.ra, payload.brandDNA, approach).map(trend => ({
        name: trend.name,
        lifecycle: trend.lifecycle,
        momentum: trend.momentum,
        score: trend.scoreSummary?.composite ?? 0,
        whyItFits: trend.rationale?.[0] || '',
        visualUrl: trend.image,
        attributes: trend.attributes,
        hashtags: trend.hashtags
      }));
    }

    payload.trends = rows.map(row => ({
      id: slugify(row.name),
      name: row.name,
      lifecycle: row.lifecycle || null,
      momentum: row.momentum || null,
      image: row.visualUrl || null,
      attributes: row.attributes || {
        colors: [],
        patterns: [],
        materials: [],
        silhouettes: []
      },
      hashtags: row.hashtags || [],
      scoreSummary: {
        composite: row.score ?? 0,
        weights: null,
        raw: { score: row.score ?? 0 }
      },
      source: 'llm',
      brandFit: row.score ?? 0,
      rationale: row.whyItFits ? [row.whyItFits] : []
    }));

    payload.rationale = rows
      .map(row => row.whyItFits)
      .filter(Boolean);

    payload.visualElements = this.createVisualMoodboard(payload.trends, payload.brandDNA, payload.ra);
    payload.brandAlignment = this.calculateBrandFit(payload.trends);

    return payload;
  }

  buildPdfSections(payload) {
    const ra = payload.ra || {};
    const brandDNA = payload.brandDNA || {};

    const raSection = [{
      heading: 'Range Architecture Overview',
      lines: [
        `RA ID: ${ra.id || 'N/A'}`,
        `Brand: ${ra.brand || 'N/A'}`,
        `Month: ${ra.month || 'N/A'}`,
        `Bricks: ${(ra.bricks || []).join(', ') || 'N/A'}`,
        `Palette: ${(ra.colors || []).join(', ') || 'N/A'}`,
        `Patterns: ${(ra.patterns || []).join(', ') || 'N/A'}`,
        `Fabrics: ${(ra.fabrics || []).join(', ') || 'N/A'}`,
        `Price Range: ${ra.priceRange || 'N/A'}`
      ]
    }];

    const dnaSection = [{
      heading: 'Brand DNA Anchors',
      lines: brandDNA?.messaging?.length ? brandDNA.messaging : ['No brand DNA messaging captured']
    }];

    const trendLines = (payload.trends || []).map(trend => {
      const attributes = [
        ...(trend.attributes?.colors || []),
        ...(trend.attributes?.materials || [])
      ].slice(0, 4).join(', ');
      const rationale = trend.rationale?.[0] || 'See markdown summary for narrative.';
      return `${trend.name} | Lifecycle: ${trend.lifecycle || 'N/A'} | Momentum: ${trend.momentum || 'N/A'} | Score: ${(trend.scoreSummary?.composite ?? 0).toFixed(1)} | Rationale: ${rationale} | Visual: ${trend.image || 'N/A'} | Attributes: ${attributes}`;
    });

    const trendSection = [{
      heading: 'Trend Tiles',
      lines: trendLines.length > 0 ? trendLines : ['No trend data supplied']
    }];

    const rationaleSection = [{
      heading: 'Brand Alignment',
      lines: [
        `Overall fit: ${payload.brandAlignment.score}% (${payload.brandAlignment.descriptor})`,
        'Rationales:',
        ...(payload.rationale.length > 0 ? payload.rationale : ['Populate via markdown response'])
      ]
    }];

    return [...raSection, ...dnaSection, ...trendSection, ...rationaleSection];
  }

  async collectImageAssets(payload) {
    const sources = [];
    const seen = new Set();

    (payload.trends || []).forEach(trend => {
      if (!trend.image) {
        return;
      }

      if (seen.has(trend.image)) {
        return;
      }

      seen.add(trend.image);

      const captionParts = [
        trend.name || '',
        trend.lifecycle ? `• ${trend.lifecycle}` : '',
        trend.momentum ? `• ${trend.momentum}` : ''
      ].filter(Boolean);

      sources.push({
        url: trend.image,
        caption: captionParts.join(' ')
      });
    });

    const assets = [];

    for (const source of sources) {
      if (assets.length >= MAX_IMAGE_ASSETS) {
        break;
      }

      const buffer = await fetchImageBuffer(source.url);
      if (!buffer || !isJpeg(buffer)) {
        continue;
      }

      const dimensions = parseJpegDimensions(buffer);
      if (!dimensions || !dimensions.width || !dimensions.height) {
        continue;
      }

      assets.push({
        url: source.url,
        buffer,
        width: dimensions.width,
        height: dimensions.height,
        caption: source.caption
      });
    }

    return assets;
  }

  async renderPdfFromPayload(payload) {
    if (!payload) {
      return null;
    }

    ensureOutputDir();

    const fileName = `${payload.ra?.id || 'RA'}-${payload.ra?.month || 'NOMONTH'}-${payload.approach}.pdf`.replace(/[^a-z0-9\-.]/gi, '_');
    const filePath = path.join(OUTPUT_DIR, fileName);

    const sections = this.buildPdfSections(payload);
    const imageAssets = await this.collectImageAssets(payload);

    const pdfBuffer = buildPdfDocument({
      title: 'Moodboard Concept Preview',
      sections,
      imageAssets
    });

    writeFileSync(filePath, pdfBuffer);
    payload.pdfPath = filePath;
    return filePath;
  }
}
