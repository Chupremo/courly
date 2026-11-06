const pdfEscape = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7E]/g, '?');

function receiptLines(receipt) {
  const paid = new Date(receipt.paid_at).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short'
  });
  return [
    'PAYMENT RECEIPT',
    'Receipt No: ' + receipt.receipt_number,
    'Date paid: ' + paid,
    'Player: ' + receipt.player_name,
    'Description: ' + receipt.description,
    'Booking reference: ' + receipt.reference,
    'Payment method: ' + (receipt.payment_method || 'Venue payment'),
    'Amount paid: PHP ' + Number(receipt.amount).toFixed(2),
    '',
    'Payment verified by the venue owner or coach.',
    'Thank you for booking with Courtly.',
    'https://www.courtlyph.com'
  ];
}

function makeReceiptPdf(receipt) {
  // The same immutable receipt snapshot produces the same attachment on retries.
  // Wrap long descriptions so ordinary venue and player names stay on the page.
  const lines = receiptLines(receipt).flatMap(line => {
    if (!line) return [''];
    return line.match(/.{1,82}(?:\s|$)|.{1,82}/g).map(part => part.trimEnd());
  });
  const commands = ['BT', '/F1 18 Tf', '50 790 Td', '(COURTLY) Tj', '/F1 10 Tf', '0 -28 Td'];
  lines.forEach((line, index) => {
    if (index) commands.push('0 -18 Td');
    commands.push('(' + pdfEscape(line) + ') Tj');
  });
  commands.push('ET');
  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream, 'utf8') + ' >>\nstream\n' + stream + '\nendstream'
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, 'utf8'));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, 'utf8');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) output += String(offsets[index]).padStart(10, '0') + ' 00000 n \n';
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, 'utf8');
}

module.exports = { makeReceiptPdf, receiptLines };
