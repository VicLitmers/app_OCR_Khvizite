require('dotenv').config();
const { ocrSpace } = require('ocr-space-api-wrapper');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Resize image to optimal size near 1MB for best OCR quality
 * - Downscales images > 1MB to avoid API limits
 * - Upscales images < 1MB for better OCR recognition
 * @param {string} imagePath - Path to the image file
 * @returns {Promise<string>} Path to the resized image (or original if already optimal)
 */
async function downsizeImage(imagePath) {
  try {
    const stats = fs.statSync(imagePath);
    const fileSizeInMB = stats.size / (1024 * 1024);
    const targetSize = 980 * 1024; // Target 980KB for optimal OCR quality
    
    console.log(`Original image size: ${fileSizeInMB.toFixed(2)} MB`);
    
    // If image is already close to target size (between 900KB and 1MB), no need to resize
    if (stats.size >= 900 * 1024 && stats.size <= 1024 * 1024) {
      console.log('Image is already optimal size (900KB-1MB), no resizing needed.');
      return imagePath;
    }
    
    // Create temporary file path
    const tempDir = path.dirname(imagePath);
    const tempFileName = `temp_resized_${Date.now()}${path.extname(imagePath)}`;
    const tempPath = path.join(tempDir, tempFileName);
    
    // Get image metadata
    const metadata = await sharp(imagePath).metadata();
    
    // Calculate resize ratio to target ~980KB
    const resizeRatio = Math.sqrt(targetSize / stats.size);
    
    const newWidth = Math.floor(metadata.width * resizeRatio);
    const newHeight = Math.floor(metadata.height * resizeRatio);
    
    if (stats.size > 1024 * 1024) {
      // Downscale large images - need to be more aggressive
      console.log(`Downscaling image to ${newWidth}x${newHeight}...`);
      
      // First attempt with calculated dimensions
      await sharp(imagePath)
        .resize(newWidth, newHeight, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ 
          quality: 88,  // Slightly lower quality for better compression
          progressive: true,
          chromaSubsampling: '4:2:0'  // Standard subsampling for better compression
        })
        .toFile(tempPath);
      
      // Check if still too large, reduce quality if needed
      let newStats = fs.statSync(tempPath);
      if (newStats.size > 1024 * 1024) {
        console.log('First attempt still too large, reducing quality...');
        fs.unlinkSync(tempPath);
        
        await sharp(imagePath)
          .resize(newWidth, newHeight, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ 
            quality: 82,  // Lower quality to ensure under 1MB
            progressive: true,
            chromaSubsampling: '4:2:0'
          })
          .toFile(tempPath);
        
        newStats = fs.statSync(tempPath);
      }
      
      const newSizeInMB = newStats.size / (1024 * 1024);
      console.log(`Final resized image size: ${newSizeInMB.toFixed(2)} MB`);
    } else {
      // Upscale small images for better OCR quality
      console.log(`Upscaling image to ${newWidth}x${newHeight} for better OCR quality...`);
      await sharp(imagePath)
        .resize(newWidth, newHeight, {
          fit: 'inside',
          kernel: sharp.kernel.lanczos3  // Best quality upscaling
        })
        .jpeg({ 
          quality: 95,  // Higher quality for upscaled images
          progressive: true,
          chromaSubsampling: '4:4:4'  // Full color info for upscaled images
        })
        .toFile(tempPath);
      
      const newStats = fs.statSync(tempPath);
      const newSizeInMB = newStats.size / (1024 * 1024);
      console.log(`Resized image size: ${newSizeInMB.toFixed(2)} MB`);
    }
    
    return tempPath;
  } catch (error) {
    console.error('Error resizing image:', error);
    return imagePath; // Return original path if resizing fails
  }
}

/**
 * Clean OCR text using simple rules:
 * - Normalize CRLF/CR to LF
 * - Replace tabs (\t) with " | " as a visual column separator
 * - Collapse multiple spaces to one
 * - Trim each line and drop empty lines
 * - If the whole text is wrapped in quotes, remove the wrapper
 * @param {string} ocrText
 * @returns {string}
 */
function cleanOcrText(ocrText) {
  let s = String(ocrText);
  // Case with string containing escape literal characters
  s = s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  // Case with actual characters
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Remove the pair of "…" and comma at the end if present
  const wrap = s.match(/^\s*"([\s\S]*?)"\s*,?\s*$/);
  if (wrap) s = wrap[1];
  // Replace tab with column separator
  s = s.replace(/\t/g, ' | ');
  // Split lines, trim spaces, and drop empty lines
  const lines = s.split(/\n/)
    .map(line => line.replace(/\s{2,}/g, ' ').trim())
    .filter(line => line.length > 0);
  return lines.join('\n');
}

// Split a line into '|' columns; drop trailing '|' and trim
function splitToCols (line) {
  return String(line || '')
    .replace(/\s*\|\s*$/, '')
    .split(/\s*\|\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Footer marker regex (lenient for OCR variants)
const FOOTER_MARKER_REGEX = /=+\s*(?:[이ㅣI|l1아]\s*)?하여백\s*=+/i;

// Create a "loose" regex for a word: allow spaces between every character
function escapeRegex (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function makeLooseRegexFromKeyword (word) {
  const chars = [...String(word)];
  const pattern = chars.map(ch => escapeRegex(ch)).join('\\s*');
  return new RegExp(pattern, 'i');
}
function buildVariantsRegex (variants) {
  const parts = variants.map(w => makeLooseRegexFromKeyword(w).source);
  return new RegExp('(' + parts.join('|') + ')', 'i');
}
// Stitch adjacent columns and match keywords with whitespace removed
function findStitchedKeywords (lines, baseKeywords, maxSpan = 4) {
  const targets = new Set(baseKeywords.map(k => String(k).replace(/\s+/g, '')));
  const results = [];
  for (let r = 0; r < lines.length; r++) {
    const cols = splitToCols(lines[r]);
    for (let i = 0; i < cols.length; i++) {
      let stitched = '';
      for (let span = 1; span <= maxSpan && i + span - 1 < cols.length; span++) {
        stitched = (span === 1) ? cols[i] : (stitched + ' ' + cols[i + span - 1]);
        const normalized = stitched.replace(/\s+/g, '');
        if (targets.has(normalized)) {
          results.push({ rowIndex: r, startCol: i, endCol: i + span - 1, stitched, normalized });
        }
      }
    }
  }
  return results;
}
// Find cells by keywords
function findCellsByKeywords (lines, variants) {
  const regex = buildVariantsRegex(variants);
  const results = [];
  for (let r = 0; r < lines.length; r++) {
    const cols = splitToCols(lines[r]);
    for (let c = 0; c < cols.length; c++) {
      const val = cols[c];
      if (regex.test(val)) results.push({ rowIndex: r, colIndex: c, value: val, line: lines[r] });
    }
  }
  return results;
}
// Check if the line is a header line
function checkIsItHeaderLine (lines) {
  try {
    // 1) Find possible header cells (loose variants)
    const seedVariants = ['단', '가', '단가'];
    const seeds = findCellsByKeywords(lines, seedVariants);

    // 2) On the same row, stitch 1..2 cells to see if they form '단가'
    const stitched = findStitchedKeywords(lines, ['단가'], 2);

    // 3) Merge results (unique by position)
    const key = h => `${h.rowIndex}:${h.startCol}-${h.endCol}`;
    const map = new Map();
    for (const s of stitched) map.set(key(s), s);
    // For discrete seeds, add as span-1 if the cell equals '단가'
    for (const s of seeds) {
      const cell = getCell(lines, s.rowIndex, s.colIndex);
      if (cell && cell.replace(/\s+/g, '') === '단가') {
        map.set(`${s.rowIndex}:${s.colIndex}-${s.colIndex}`, {
          rowIndex: s.rowIndex,
          startCol: s.colIndex,
          endCol: s.colIndex,
          stitched: cell,
          normalized: '단가'
        });
      }
    }
    return Array.from(map.values());
  } catch (error) {
    console.log(error);
    return [];
  }
}
// Check if the line is a footer line
function checkIsItFooterLine (lines) {
  try {
    for (let r = 0; r < lines.length; r++) {
      if (FOOTER_MARKER_REGEX.test(lines[r])) {
        return [{ type: 'footer_marker', rowIndex: r, colIndex: null, value: lines[r], line: lines[r] }];
      }
    }
    // If no explicit marker, fall back to the earliest '인수자' cell
    const assigneeHits = findCellsByKeywords(lines, ['인수자']);
    if (assigneeHits.length > 0) {
      const earliest = assigneeHits.reduce((a, b) => (a.rowIndex <= b.rowIndex ? a : b));
      return [{ type: 'assignee', ...earliest }];
    }
    return [];
  } catch (error) {
    console.log(error);
    return [];
  }
}
  
// Get cell value by row/column index
function getCell (lines, rowIndex, colIndex) {
  if (!Array.isArray(lines) || rowIndex < 0 || rowIndex >= lines.length) return null;
  const cols = splitToCols(lines[rowIndex]);
  return colIndex >= 0 && colIndex < cols.length ? cols[colIndex] : null;
}

// (intentionally left blank)

// Slice rows between header and footer using offsets

function sliceRowsBetweenHeaderFooter (lines) {
  const headers = checkIsItHeaderLine(lines);
  if (!headers.length) return { start: null, end: null, rows: [] };
  const headerIndex = Math.min(...headers.map(h => h.rowIndex));
  const footers = checkIsItFooterLine(lines);
  if (!footers.length) return { start: headerIndex + 1, end: null, rows: lines.slice(headerIndex + 1) };
  const firstFooter = footers.reduce((a, b) => (a.rowIndex <= b.rowIndex ? a : b));
  const start = Math.min(Math.max(headerIndex + 1, 0), lines.length);
  // Calculate the end index of the rows to be sliced
  let endCut = firstFooter.rowIndex;
  if (firstFooter.type === 'footer_marker') endCut = firstFooter.rowIndex - 1; // before '이하여백' 1 line
  if (firstFooter.type === 'assignee') endCut = firstFooter.rowIndex - 2; // before '인수자' 2 line
  const end = Math.max(Math.min(endCut, lines.length - 1), -1);
  const rows = start <= end ? lines.slice(start, end + 1) : [];
  return { start, end, rows };
}

// -------------------------
// Parse items block -> structured rows
// -------------------------
function toIntStrict (s) {
  const n = String(s || '').replace(/[^0-9]/g, '');
  return n ? parseInt(n, 10) : null;
}

// Accept only clean money tokens (e.g., 55,000 or 5000) without letters
function isMoneyToken (s) {
  const t = String(s || '').trim();
  return /^(\d{1,3}(,\d{3})+|\d{4,})$/.test(t);
}

// (intentionally left blank)

// Extract specification from a text; prefer content after '-' or standalone units
function extractSpecificationFromText (text) {
  const str = String(text || '');
  const patterns = [
    /-\s*([0-9]+(?:\.[0-9]+)?\s*(?:kg|g|l|ml|cm|mm|ea)(?:\s*\*\s*\d+(?:\s*ea)?)?)/i,
    /\b([0-9]+(?:\.[0-9]+)?\s*(?:kg|g|l|ml|cm|mm|ea)(?:\s*\*\s*\d+(?:\s*ea)?)?)\b/i
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Split specification from the item name if present; keep the remaining text as item
function splitSpecFromItemName (text) {
  const s = String(text || '');
  // Ignore content inside parentheses when detecting specification
  const parenSpans = [];
  {
    const parenRe = /\([^()]*\)/g;
    let m;
    while ((m = parenRe.exec(s))) {
      parenSpans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  const isInsideParens = (idx) => parenSpans.some(sp => idx >= sp.start && idx < sp.end);
  // Prefer pattern after '-'
  const afterDash = s.match(/-\s*([0-9]+(?:\.[0-9]+)?\s*(?:kg|g|l|ml|cm|mm|ea)(?:\s*\*\s*\d+(?:\s*ea)?)?(?:\s+\d{1,3})?)/i);
  if (afterDash) {
    const spec = afterDash[1].replace(/\s+/g, ' ').trim();
    const item = s.slice(0, afterDash.index).replace(/[-—]\s*$/, '').trim();
    return { item, spec };
  }
  // Otherwise, look for standalone spec
  {
    // Look for standalone spec
    const re = /\b([0-9]+(?:\.[0-9]+)?\s*(?:kg|g|l|ml|cm|mm|ea)(?:\s*\*\s*\d+(?:\s*ea)?)?(?:\s+\d{1,3})?)\b/ig;
    let m;
    while ((m = re.exec(s))) {
      if (isInsideParens(m.index)) continue;
      const spec = m[1].replace(/\s+/g, ' ').trim();
      const item = s.replace(m[0], '').replace(/\s{2,}/g, ' ').replace(/[-—]\s*$/, '').trim();
      return { item, spec };
    }
  }
  return { item: s.trim(), spec: '' };
}

function parseItemRow (cols) {
  if (!cols || cols.length === 0) return null;

  // Item name is the first column
  const rawItem = (cols[0] || '').trim();
  if (!rawItem) return null;
  let item = rawItem;
  let specification = '';
  // Prefer splitting specification from item name when possible
  {
    const split = splitSpecFromItemName(rawItem);
    item = split.item;
    specification = split.spec;
  }
  // Rule: if item name is purely numeric, try to take the next non-numeric column as item name
  {
    const normalizeDigits = (s) => String(s || '').replace(/[\s,.-]/g, '');
    let normalized = normalizeDigits(item);
    if (/^\d+$/.test(normalized)) {
      for (let j = 1; j < cols.length; j++) {
        const candidate = String(cols[j] || '').trim();
        if (!candidate) continue;
        const candNorm = normalizeDigits(candidate);
        if (!/^\d+$/.test(candNorm)) {
          // Prefer tokens containing letters (Korean/Latin); otherwise any non-numeric token
          if (/[A-Za-z가-힣]/.test(candidate) || candNorm.length > 0) {
            item = candidate;
            // Recompute spec from the new item if missing
            const split2 = splitSpecFromItemName(item);
            item = split2.item;
            if (!specification) specification = split2.spec;
            break;
          }
        }
      }
      normalized = normalizeDigits(item);
      if (/^\d+$/.test(normalized)) return null;
    }
  }
  // If still missing and next column is not a plain quantity, try column 1
  if (!specification && cols.length > 1) {
    const nextCol = String(cols[1]).trim();
    if (!/^\d{1,2}$/.test(nextCol)) {
      // attempt to extract spec from column 1; otherwise use the raw column
      const extracted = extractSpecificationFromText(nextCol);
      specification = extracted || nextCol;
    }
  }

  // Normalize: if specification is only '-', treat as null
  if (typeof specification === 'string' && specification.trim() === '-') {
    specification = null;
  }

  // Quantity: integer with 1–2 digits
  const quantityCandidates = [];
  for (let i = 1; i < cols.length; i++) {
    if (/^\d{1,2}$/.test(cols[i].trim())) quantityCandidates.push({ i, n: parseInt(cols[i].trim(), 10) });
  }
  let quantity = null;
  let quantityIndex = null;
  if (quantityCandidates.length === 1) {
    quantity = quantityCandidates[0].n;
    quantityIndex = quantityCandidates[0].i;
  }

  // Unit price and supply amount: prefer two consecutive numbers >= 1000
  const money = [];
  for (let i = Math.max(1, (quantityIndex != null ? quantityIndex + 1 : 1)); i < cols.length; i++) {
    const token = cols[i];
    if (!isMoneyToken(token)) continue;
    const n = toIntStrict(token);
    if (n !== null && n >= 1000) money.push({ i, n });
  }
  // Take the first two consecutive amounts if available; otherwise accept a single unitPrice
  let unitPrice = null;
  let unitPriceIndex = null;
  let supplyAmount = null;
  let supplyAmountIndex = null;
  for (let k = 0; k < money.length - 1; k++) {
    if (money[k + 1].i === money[k].i + 1) {
      unitPrice = money[k].n;
      unitPriceIndex = money[k].i;
      supplyAmount = money[k + 1].n;
      supplyAmountIndex = money[k + 1].i;
      break;
    }
  }
  if (unitPrice === null && money.length >= 1) {
    unitPrice = money[0].n;
    unitPriceIndex = money[0].i;
    // Try to find the next amount for supply (not necessarily adjacent)
    const nextMoney = money.find(m => m.i > unitPriceIndex);
    if (nextMoney) {
      supplyAmount = nextMoney.n;
      supplyAmountIndex = nextMoney.i;
    } else {
      supplyAmount = null;
      supplyAmountIndex = null;
    }
  }
  if (unitPrice === null) return null;

  // Fallback: if quantity is still null, pick the first candidate not overlapping unit/supply indices
  if (quantity == null && quantityCandidates.length > 0) {
    const occupied = new Set([unitPriceIndex, supplyAmountIndex].filter(v => v != null));
    const q = quantityCandidates.find(q => !occupied.has(q.i));
    if (q) {
      quantity = q.n;
      quantityIndex = q.i;
    }
  }

  return { item, specification, quantity, unitPrice, supplyAmount };
}

// Parse items from rows
function parseItemsFromRows (rows) {
  const items = [];
  for (const line of rows) {
    const cols = splitToCols(line);
    const row = parseItemRow(cols);
    // Accept rows with unitPrice even if supplyAmount is null
    if (row && row.unitPrice !== null) items.push(row);
  }
  return items;
}


// Clean rows with rules and return both kept and removed
function cleanRowsWithRules (rows) {
  const rules = [
    { pattern: /softcity\.co\.kr/i },
    { pattern: /www\./i},
    { pattern: /NO/i},
    { pattern: /BOX/i},
    { pattern: /EA/i},
    { pattern: /특허출원/i },
    { pattern: /0K\s*aF/i},
    // Drop header-like merged column '품목-규격' with flexible dash/spaces
    { pattern: /품목\s*[-–—~]\s*규격/i },
    // Remove company tagline variants (OCR): 경영박사 / 1영박사
    { pattern: /(경영박사|1영박사)/i },
    // Remove standalone header tokens
    { pattern: /^품목$/i },
    { pattern: /^-?\s*규격$/i },
    { pattern: /^수량$/i },
  ];
  const kept = [];
  const removed = [];
  // Queue to hold stray numeric values from standalone lines
  const numericQueue = [];
  // First queue fill uses a stricter threshold (<5); subsequent fills use (<6)
  let firstQueueFill = true;
  const isNumericToken = (s) => {
    const t = String(s || '').replace(/[\s,]/g, '');
    return /^\d+(?:\.\d+)?$/.test(t);
  };
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r];
    const cols = splitToCols(line);
    const newCols = [];
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      const hit = rules.find(rule => rule.pattern.test(col));
      if (hit) {
        removed.push({ rowIndex: r, colIndex: c, line, column: col });
        continue; // drop this column only
      }
      newCols.push(col);
    }
    // Heuristic: prune leading ID-like prefix if the remaining columns already look like a full data row
    if (newCols.length >= 7) {
      const looksLikePrefixId = (s) => /^(?:\d{1,2}\.\d{1,2}\s+\S+|[A-Za-z]{2,}\d{2,}|\d{6,})$/.test(String(s || '').trim());
      const isUnitToken = (s) => /^(?:kg|g|l|ml|cm|mm|ea)$/i.test(String(s || '').trim());
      const isQuantityLike = (s) => /^\d{1,2}$/.test(String(s || '').trim());
      const rest = newCols.slice(1);
      const hasUnit = rest.some(isUnitToken);
      const quantityCount = rest.filter(isQuantityLike).length;
      const moneyCount = rest.filter(isMoneyToken).length;
      if (!isMoneyToken(newCols[0]) && looksLikePrefixId(newCols[0]) && hasUnit && moneyCount >= 2 && quantityCount >= 1) {
        removed.push({ rowIndex: r, colIndex: 0, line, column: newCols[0], reason: 'prefix_pruned' });
        newCols.shift();
      }
    }
    // If this line is purely numeric tokens, push them to the front of queue and skip row
    if (newCols.length > 0 && newCols.every(isNumericToken)) {
      numericQueue.unshift(...newCols);
      continue;
    }
    // If queue has values: if row has < threshold columns, append values; otherwise replace last k cells
    if (numericQueue.length > 0 && newCols.length > 0) {
      const n = newCols.length;
      // If the row does not contain a quantity-like token (1-2 digits), treat it as missing one slot
      const hasQuantityLike = newCols.some(col => /^\d{1,2}$/.test(String(col).trim()));
      const nEffective = n + (hasQuantityLike ? 0 : 1);
      const threshold = firstQueueFill ? 5 : 6;
      if (nEffective < threshold) {
        const need = threshold - nEffective;
        const addCount = Math.max(0, Math.min(numericQueue.length, need));
        for (let j = 0; j < addCount; j++) newCols.push(numericQueue.shift());
        if (addCount > 0) firstQueueFill = false;
      } else {
        const k = Math.min(numericQueue.length, n);
        for (let j = 0; j < k; j++) {
          const idx = n - k + j;
          const replaced = newCols[idx];
          newCols[idx] = numericQueue.shift();
          numericQueue.push(replaced);
        }
        if (k > 0) firstQueueFill = false;
      }
    }
    const joined = newCols.join(' | ').trim();
    if (joined.length === 0) {
      continue; // drop entire row if empty after filtering
    }
    kept.push(joined);
  }
  return { kept, removed };
}
  // ---- MAIN (OCR call) ----
  async function main () {
    console.time('Total Run Time');
    console.time('OCR respond time');
    try {
      // Get image path from environment variable or use default (relative to project root)
      const defaultImagePath = path.join(__dirname, 'images', 'pic1-1.jpg');
      const originalImagePath = process.env.IMAGE_PATH || defaultImagePath;
      
      if (!fs.existsSync(originalImagePath)) {
        throw new Error(`Image file not found: ${originalImagePath}. Please set IMAGE_PATH in .env file or provide a valid path.`);
      }
      
      // Downsize image if needed before OCR
      const imagePath = await downsizeImage(originalImagePath);
      
      // Get OCR API key from environment
      const ocrApiKey = process.env.OCR_SPACE_API_KEY;
      if (!ocrApiKey) {
        throw new Error('OCR_SPACE_API_KEY is not set in .env file. Please add it to continue.');
      }
      
      const ocrResult = await ocrSpace(
        imagePath,
        {
          apiKey: ocrApiKey,
          language: 'kor',
          isTable: true,
          OCREngine: 2,
        }
      );
      console.timeEnd('OCR respond time');
      console.time('sorting Run Time')
      const text = ocrResult?.ParsedResults?.[0]?.ParsedText || '';
      const result = cleanOcrText(text);
      const lines = result.split('\n');
      console.log('lines:', lines);


      const stitchedHits = checkIsItHeaderLine(lines);
      stitchedHits.forEach(h => console.log(`[STITCH row ${h.rowIndex}, ${h.startCol}-${h.endCol}] =>`, h.stitched));

      const footerHits = checkIsItFooterLine(lines);
     footerHits.forEach(h => console.log(`[FOOTER ${h.type}] row=${h.rowIndex}, col=${h.colIndex} =>`, h.value));

      const slice = sliceRowsBetweenHeaderFooter(lines);
      console.log('rows slice start-end:', slice.start, slice.end);
      console.log(slice.rows);

      // Clean rows: get kept vs removed for inspection
      const cleaned = cleanRowsWithRules(slice.rows);
      console.log('Removed rows by rules:', cleaned.removed);
      console.log('Kept rows:', cleaned.kept);

      // Parse structured items from the sliced rows
      const items = parseItemsFromRows(cleaned.kept);
      console.log('Parsed items:');
      console.log(JSON.stringify(items, null, 2));
      
      // Cleanup: delete temporary resized image if it was created
      if (imagePath !== originalImagePath && fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
        console.log('Cleaned up temporary resized image');
      }
    } catch (error) {
      console.error('OCR/main error:', error);
    } finally {
      console.timeEnd('sorting Run Time');
      console.timeEnd('Total Run Time');
    }
  }
  if (require.main === module) {
    main();
  }