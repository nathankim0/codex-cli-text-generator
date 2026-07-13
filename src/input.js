import fs from 'node:fs/promises';
import path from 'node:path';

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (quoted) throw new Error('Invalid CSV: unterminated quoted field.');
  return rows;
}

function readPath(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], object);
}

export function renderTemplate(template, data) {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_match, key) => {
    const value = readPath(data, key);
    if (value === undefined || value === null) {
      throw new Error(`Template value is missing: ${key}`);
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

function normalizeJobs(records, template) {
  return records.map((record, index) => {
    const data = typeof record === 'string' ? { prompt: record } : record;
    if (!data || Array.isArray(data) || typeof data !== 'object') {
      throw new Error(`Input item ${index + 1} must be a string or object.`);
    }
    const prompt = template ? renderTemplate(template, data) : data.prompt;
    if (!String(prompt ?? '').trim()) {
      throw new Error(`Input item ${index + 1} has no prompt. Add a prompt field or use --template-file.`);
    }
    return {
      id: String(data.id ?? index + 1),
      prompt: String(prompt),
      data,
      index,
    };
  });
}

export async function loadJobs(inputPath, { template } = {}) {
  const content = await fs.readFile(inputPath, 'utf8');
  const extension = path.extname(inputPath).toLowerCase();
  let records;

  if (extension === '.jsonl' || extension === '.ndjson') {
    records = content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
  } else if (extension === '.json') {
    records = JSON.parse(content);
    if (!Array.isArray(records)) throw new Error('JSON input must contain an array.');
  } else if (extension === '.csv') {
    const [headers, ...rows] = parseCsv(content).filter((row) => row.some((value) => value.trim()));
    if (!headers) return [];
    records = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  } else {
    records = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  return normalizeJobs(records, template);
}

export async function loadTemplate(templateFile) {
  return templateFile ? fs.readFile(templateFile, 'utf8') : undefined;
}

export const inputInternals = { parseCsv };
