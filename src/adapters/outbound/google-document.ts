/** Native Docs copy support for HTML imported by Drive. No Apps Script runtime is needed. */
export type DocsRequest = Record<string, any>;
export type DocsNode = Record<string, any>;
export interface ImportedDocument {
  body: { content: DocsNode[] };
  inlineObjects?: Record<string, DocsNode>;
  lists?: Record<string, DocsNode>;
  documentStyle?: DocsNode;
  revisionId?: string;
}

const textFields = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'smallCaps',
  'backgroundColor',
  'foregroundColor',
  'fontSize',
  'weightedFontFamily',
  'baselineOffset',
  'link',
];
const paragraphFields = [
  'namedStyleType',
  'alignment',
  'lineSpacing',
  'spaceAbove',
  'spaceBelow',
  'indentStart',
  'indentEnd',
  'indentFirstLine',
  'keepWithNext',
  'avoidWidowAndOrphan',
  'borderTop',
  'borderBottom',
  'borderLeft',
  'borderRight',
  'borderBetween',
];
const cellFields = [
  'backgroundColor',
  'borderTop',
  'borderBottom',
  'borderLeft',
  'borderRight',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'contentAlignment',
];
function writable(value: DocsNode = {}, fields: string[]): DocsNode {
  return Object.fromEntries(
    fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
}
export function contentWidth(document: ImportedDocument): number {
  const style = document.documentStyle;
  const width = style?.documentSize?.width?.magnitude;
  return Math.min(
    468,
    width
      ? width - (style?.marginLeft?.magnitude || 0) - (style?.marginRight?.magnitude || 0)
      : 468,
  );
}
function image(document: ImportedDocument, objectId: string, maxWidth: number) {
  const object = document.inlineObjects?.[objectId]?.inlineObjectProperties?.embeddedObject;
  const uri = object?.imageProperties?.contentUri;
  if (!uri) throw new Error('Imported image cannot be copied by the Google Docs API');
  const width = object.size?.width?.magnitude;
  const height = object.size?.height?.magnitude;
  const scale = width ? Math.min(1, maxWidth / width) : 1;
  return {
    uri,
    ...(width && height
      ? {
          objectSize: {
            width: { magnitude: width * scale, unit: 'PT' },
            height: { magnitude: height * scale, unit: 'PT' },
          },
        }
      : { objectSize: { width: { magnitude: maxWidth, unit: 'PT' } } }),
  };
}

/** Reject unsupported imports before editing the user's existing document. */
export function validateImport(document: ImportedDocument) {
  let count = 0;
  const visit = (nodes: DocsNode[]) => {
    for (const node of nodes) {
      if (++count > 500) throw new Error('Document import exceeds 500 structural elements');
      if (node.sectionBreak) continue;
      if (node.paragraph) {
        if (node.paragraph.positionedObjectIds?.length)
          throw new Error('Positioned images are not supported; use inline images');
        for (const element of node.paragraph.elements || []) {
          if (element.textRun) {
            if (
              element.textRun.textStyle?.link?.bookmarkId ||
              element.textRun.textStyle?.link?.headingId
            )
              throw new Error('Internal document links cannot be copied; use URL links');
          } else if (element.inlineObjectElement)
            image(document, element.inlineObjectElement.inlineObjectId, 468);
          else if (!element.horizontalRule) throw new Error('Unsupported imported inline element');
        }
      } else if (node.table) {
        for (const row of node.table.tableRows || []) {
          if (row.tableCells.length !== node.table.columns)
            throw new Error('Merged table cells are not supported');
          for (const cell of row.tableCells) {
            if (
              (cell.tableCellStyle?.rowSpan || 1) !== 1 ||
              (cell.tableCellStyle?.columnSpan || 1) !== 1
            )
              throw new Error('Merged table cells are not supported');
            visit(cell.content);
          }
        }
      } else throw new Error('Unsupported imported document structure');
    }
  };
  visit(document.body.content);
}

export function paragraphRequests(
  document: ImportedDocument,
  paragraph: DocsNode,
  index: number,
  maxWidth: number,
  reuseFinalParagraph = false,
): DocsRequest[] {
  const requests: DocsRequest[] = [];
  const styles: DocsRequest[] = [];
  const nesting = paragraph.bullet?.nestingLevel || 0;
  // Docs derives list nesting from leading tabs and removes them when creating bullets.
  let cursor = index;
  if (nesting) {
    requests.push({ insertText: { location: { index: cursor }, text: '\t'.repeat(nesting) } });
    cursor += nesting;
  }
  for (const element of paragraph.elements || []) {
    if (element.textRun) {
      const raw = element.textRun.content || '';
      const text =
        element === paragraph.elements.at(-1) && raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      if (!text) continue;
      requests.push({ insertText: { location: { index: cursor }, text } });
      const textStyle = writable(element.textRun.textStyle, textFields);
      // Reset inherited formatting as well as applying explicit imported styles.
      styles.push({
        updateTextStyle: {
          range: { startIndex: cursor, endIndex: cursor + text.length },
          textStyle,
          fields: textFields.join(','),
        },
      });
      cursor += text.length;
    } else if (element.inlineObjectElement) {
      requests.push({
        insertInlineImage: {
          location: { index: cursor },
          ...image(document, element.inlineObjectElement.inlineObjectId, maxWidth),
        },
      });
      cursor++;
    } else if (element.horizontalRule) {
      // The REST API has no insertHorizontalRule; a paragraph border renders the rule.
      paragraph = {
        ...paragraph,
        paragraphStyle: {
          ...paragraph.paragraphStyle,
          borderBottom: {
            color: { color: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } } },
            width: { magnitude: 1, unit: 'PT' },
            padding: { magnitude: 1, unit: 'PT' },
            dashStyle: 'SOLID',
          },
        },
      };
    }
  }
  if (!reuseFinalParagraph)
    requests.push({ insertText: { location: { index: cursor }, text: '\n' } });
  cursor++;
  const range = { startIndex: index, endIndex: cursor };
  requests.push(
    ...styles,
    { deleteParagraphBullets: { range } },
    {
      updateParagraphStyle: {
        range,
        paragraphStyle: writable(paragraph.paragraphStyle, paragraphFields),
        fields: paragraphFields.join(','),
      },
    },
  );
  if (paragraph.bullet) {
    const level =
      document.lists?.[paragraph.bullet.listId]?.listProperties?.nestingLevels?.[nesting];
    const numbered = level?.glyphType && level.glyphType !== 'GLYPH_TYPE_UNSPECIFIED';
    requests.push({
      createParagraphBullets: {
        range,
        bulletPreset: numbered ? 'NUMBERED_DIGIT_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  return requests;
}

export function oversizedImageRequests(document: ImportedDocument): DocsRequest[] {
  const requests: DocsRequest[] = [];
  const visit = (nodes: DocsNode[], maxWidth: number) => {
    for (const node of nodes) {
      if (node.paragraph)
        for (const element of node.paragraph.elements || []) {
          const objectId = element.inlineObjectElement?.inlineObjectId;
          const width =
            document.inlineObjects?.[objectId]?.inlineObjectProperties?.embeddedObject?.size?.width
              ?.magnitude;
          if (objectId && width > maxWidth)
            requests.push(
              {
                deleteContentRange: {
                  range: { startIndex: element.startIndex, endIndex: element.endIndex },
                },
              },
              {
                insertInlineImage: {
                  location: { index: element.startIndex },
                  ...image(document, objectId, maxWidth),
                },
              },
            );
        }
      if (node.table)
        for (const row of node.table.tableRows)
          for (const cell of row.tableCells) visit(cell.content, maxWidth / node.table.columns);
    }
  };
  // Each delete/reinsert pair leaves indexes unchanged.
  visit(document.body.content, contentWidth(document));
  return requests;
}

export function tableCellStyle(style: DocsNode): DocsNode {
  return writable(style, cellFields);
}
