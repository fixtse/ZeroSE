import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { Media } from '../src/adapters/outbound/media.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('oversized bounded collections fail before parsing individual elements', () => {
  let visited = 0;
  const element = z.preprocess((value) => {
    visited++;
    return value;
  }, z.string());
  const results = [
    z.array(element).max(2).safeParse([1, 2, 3]),
    z
      .set(element)
      .max(2)
      .safeParse(new Set([1, 2, 3])),
    z
      .map(element, element)
      .max(2)
      .safeParse(
        new Map([
          [1, 1],
          [2, 2],
          [3, 3],
        ]),
      ),
  ];
  for (const result of results) {
    assert.equal(result.success, false);
    assert.equal(result.error?.issues.length, 1);
    assert.equal(result.error?.issues[0].code, 'too_big');
  }
  assert.equal(visited, 0);
});

test('ExcelJS still writes and Zero extracts XLSX workbooks with the patched UUID dependency', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Security check').addRow(['private example', 42]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const dataDir = mkdtempSync(join(tmpdir(), 'zero-security-media-'));
  const media = new Media(ConfigSchema.parse({ apiKey: 'test-key-that-is-long-enough', dataDir }));
  try {
    const result = await media.extract(
      buffer,
      'example.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'security-dependency-check',
      new AbortController().signal,
    );
    assert.match(result.text, /Security check/);
    assert.match(result.text, /private example/);
    assert.match(result.text, /42/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
