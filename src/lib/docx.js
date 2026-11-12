/* Minimal Word (.docx) writer: one section per page, holding either paragraphs of text or a full-page picture. */

const TWIPS = 20; // per point
const EMU = 12700; // per point

const escapeXml = (s) =>
  s
    // Characters XML 1.0 does not allow at all.
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** `text` may contain tabs. `size` is in points. */
function paragraph({ text, size, center }) {
  const runs = text
    .split('\t')
    .map((part) => `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`)
    .join('<w:tab/>');
  const half = Math.round(size * 2);
  return `<w:p><w:pPr><w:spacing w:after="120"/>${center ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:r><w:rPr><w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>${runs}</w:r></w:p>`;
}

/** Picture covering the whole page, anchored to it so no paragraph spacing can push it onto a second page. */
function picture(index, width, height) {
  const size = `cx="${Math.round(width * EMU)}" cy="${Math.round(height * EMU)}"`;
  return (
    `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
    `<wp:extent ${size}/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${index}" name="Página ${index}"/><wp:cNvGraphicFramePr/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="Página ${index}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rId${index}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${size}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>` +
    `</wp:anchor></w:drawing></w:r>`
  );
}

function sectionProps({ width, height, margin = {} }) {
  const twips = (points) => Math.round((points || 0) * TWIPS);
  return (
    `<w:sectPr><w:pgSz w:w="${twips(width)}" w:h="${twips(height)}"${width > height ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${twips(margin.top)}" w:right="${twips(margin.right)}" w:bottom="${twips(margin.bottom)}" w:left="${twips(margin.left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`
  );
}

/**
 * Builds a .docx. Each page is { width, height, margin?, paragraphs?: [{ text, size, center? }], jpeg?: Blob },
 * with sizes in points. Returns a Blob.
 */
export async function writeDocx(pages) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const rels = [];
  const body = pages.map((page, i) => {
    const last = i === pages.length - 1;
    let content = (page.paragraphs || []).map(paragraph).join('');
    let closing = '';
    if (page.jpeg) {
      const n = i + 1;
      zip.file(`word/media/pagina${n}.jpeg`, page.jpeg);
      rels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pagina${n}.jpeg"/>`);
      closing = picture(n, page.width, page.height);
    }
    // A section's properties live in its last paragraph, except the final section's, which close the body.
    if (last) return `${content}${closing ? `<w:p>${closing}</w:p>` : ''}${sectionProps(page)}`;
    return `${content}<w:p><w:pPr>${sectionProps(page)}</w:pPr>${closing}</w:p>`;
  });

  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  zip.file(
    '[Content_Types].xml',
    `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file('word/_rels/document.xml.rels', `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  zip.file(
    'word/document.xml',
    `${header}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}
