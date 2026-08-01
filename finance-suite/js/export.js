/**
 * Export breakdown tables to Excel (.xlsx) and PDF.
 * Requires SheetJS (XLSX) and jsPDF + autotable loaded via CDN in index.html.
 */

function ensureExportLibs(format) {
  if (format === 'excel' && typeof XLSX === 'undefined') {
    throw new Error('Excel export library not loaded. Please refresh the page.');
  }
  if (format === 'pdf' && (typeof jspdf === 'undefined' || !jspdf.jsPDF)) {
    throw new Error('PDF export library not loaded. Please refresh the page.');
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string[]} opts.headers
 * @param {string[][]} opts.rows - pre-formatted cell strings
 * @param {string} opts.filename
 */
export function downloadExcel({ title, headers, rows, filename }) {
  ensureExportLibs('excel');

  const wsData = [[title], [], headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = headers.map(() => ({ wch: 18 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Breakdown');
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  triggerDownload(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string[]} opts.headers
 * @param {string[][]} opts.rows
 * @param {string} opts.filename
 */
export function downloadPDF({ title, headers, rows, filename }) {
  ensureExportLibs('pdf');

  const { jsPDF } = jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  doc.setFontSize(14);
  doc.text(title, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`Generated ${new Date().toLocaleString()}`, 14, 22);
  doc.setTextColor(0);

  doc.autoTable({
    head: [headers],
    body: rows,
    startY: 28,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [34, 197, 94], textColor: 255 },
    alternateRowStyles: { fillColor: [245, 245, 245] },
  });

  doc.save(filename);
}
