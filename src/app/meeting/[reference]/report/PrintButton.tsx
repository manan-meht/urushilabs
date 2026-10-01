'use client'

import { useEffect } from 'react'

/**
 * Opens the browser's print dialog, where "Save as PDF" is the destination.
 * The browser does the PDF: it is the only renderer available to us that
 * shapes Devanagari correctly, and reports follow the meeting's language.
 */
export function PrintButton({ autoPrint }: { autoPrint: boolean }) {
  useEffect(() => {
    if (!autoPrint) return
    const t = setTimeout(() => window.print(), 400)
    return () => clearTimeout(t)
  }, [autoPrint])

  return (
    <div className="print:hidden flex flex-wrap items-center gap-3 mb-8">
      <button
        onClick={() => window.print()}
        className="h-11 px-5 bg-primary text-on-primary rounded-xl font-bold text-body-md hover:opacity-90 transition-all"
      >
        Save as PDF
      </button>
      <p className="font-body-sm text-on-surface-variant">In the print dialog, choose <strong>Save as PDF</strong> as the destination.</p>
    </div>
  )
}
