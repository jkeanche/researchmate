"""Convert DOCX to PDF with LibreOffice, updating the table of contents first.

Usage: python3 lo_convert.py <pipe-name> <input.docx> <output.pdf>
Connects to a LibreOffice instance started with --accept="pipe,name=<pipe>;urp;".
"""
import sys
import time

import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def main():
    pipe, src, dst = sys.argv[1:4]
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    ctx = None
    for _ in range(300):
        try:
            ctx = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
            break
        except Exception:
            time.sleep(0.1)
    if ctx is None:
        print("could not connect to LibreOffice", file=sys.stderr)
        sys.exit(3)
    desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(src), "_blank", 0, (prop("Hidden", True), prop("ReadOnly", True)))
    if doc is None:
        print("could not open document", file=sys.stderr)
        sys.exit(4)
    indexes = doc.getDocumentIndexes()
    count = indexes.getCount()
    # Twice: filling the contents can move headings to later pages.
    for _ in range(2):
        for i in range(indexes.getCount()):
            indexes.getByIndex(i).update()
        doc.refresh()
    doc.storeToURL(uno.systemPathToFileUrl(dst), (prop("FilterName", "writer_pdf_Export"),))
    doc.close(True)
    try:
        desktop.terminate()
    except Exception:
        pass
    print("ok indexes=%d" % count)


main()
