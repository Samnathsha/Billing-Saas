"""Phase 10 hand test checklist (offline tills) as a printable PDF (A4).

Developer tool, not part of the app. Needs Python with reportlab (and macOS
fonts SF Pro and Arial Bold, for the rupee sign):
    python3 -m venv /tmp/pdfenv && /tmp/pdfenv/bin/pip install reportlab
    /tmp/pdfenv/bin/python docs/hand-tests/make_phase10_pdf.py docs/hand-tests/phase-10-hand-test.pdf
"""
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

OUT = sys.argv[1]

# SF Pro has the rupee sign; Arial Bold is used only for text without it.
pdfmetrics.registerFont(TTFont("Body", "/Library/Fonts/SF-Pro.ttf"))
pdfmetrics.registerFont(TTFont("Bold", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"))

INK = colors.HexColor("#1f2933")
MUTED = colors.HexColor("#5f6b7a")
LINE = colors.HexColor("#c9d1db")
TINT = colors.HexColor("#f2f5f8")

title = ParagraphStyle("title", fontName="Bold", fontSize=20, leading=25, textColor=INK, spaceAfter=4)
subtitle = ParagraphStyle("subtitle", fontName="Body", fontSize=10.5, leading=14, textColor=MUTED, spaceAfter=10)
h1 = ParagraphStyle("h1", fontName="Bold", fontSize=14, leading=18, textColor=INK, spaceBefore=10, spaceAfter=6, keepWithNext=1)
scen = ParagraphStyle("scen", fontName="Bold", fontSize=12, leading=15, textColor=INK, spaceAfter=3)
label = ParagraphStyle("label", fontName="Bold", fontSize=9, leading=12, textColor=MUTED, spaceBefore=3, spaceAfter=1)
body = ParagraphStyle("body", fontName="Body", fontSize=10, leading=13.5, textColor=INK, alignment=TA_LEFT)
small = ParagraphStyle("small", fontName="Body", fontSize=9, leading=12, textColor=MUTED)


class Box(Flowable):
    """An empty square to tick by hand."""

    def __init__(self, size=11):
        super().__init__()
        self.size = size
        self.width = size
        self.height = size

    def draw(self):
        self.canv.setStrokeColor(INK)
        self.canv.setLineWidth(1)
        self.canv.rect(0, 0, self.size, self.size)


def steps(items):
    return ListFlowable([ListItem(Paragraph(t, body), leftIndent=12) for t in items], bulletType="1", bulletFontName="Body", bulletFontSize=10, leftIndent=14)


def expect(items):
    return ListFlowable([ListItem(Paragraph(t, body), leftIndent=12, value="•") for t in items], bulletType="bullet", start="•", bulletFontName="Body", bulletFontSize=10, leftIndent=14)


def result_row():
    t = Table(
        [[Box(), Paragraph("Passed", body), Box(), Paragraph("Different (write what you saw):", body), ""]],
        colWidths=[5 * mm, 18 * mm, 5 * mm, 58 * mm, 66 * mm],
        rowHeights=[9 * mm],
    )
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LINEBELOW", (4, 0), (4, 0), 0.6, LINE), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    return t


def scenario(number, name, do, see, note=None):
    parts = [
        Paragraph(f"{number}. {name}", scen),
        Paragraph("DO", label),
        steps(do),
        Paragraph("YOU SHOULD SEE", label),
        expect(see),
    ]
    if note:
        parts.append(Spacer(1, 2))
        parts.append(Paragraph(note, small))
    parts.append(Spacer(1, 3))
    parts.append(result_row())
    box = Table([[parts]], colWidths=[170 * mm])
    box.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return KeepTogether([box, Spacer(1, 7)])


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Body", 8.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(20 * mm, 12 * mm, "Billing app · Phase 10 hand test · offline tills")
    canvas.drawRightString(190 * mm, 12 * mm, f"Page {doc.page}")
    canvas.restoreState()



story = [
    Paragraph("Phase 10 hand test", title),
    Paragraph("Offline tills: billing with the Wi-Fi switched off, returns, sync, what to check afterwards, and revoking a till. 9 scenarios, about 25 minutes, on the computer that will be the till. Do them in order.", subtitle),
]

intro = Table(
    [
        [Paragraph("<font name='Bold'>How to use this</font>", body)],
        [Paragraph("Tick <b>Passed</b> when the screen shows exactly what is written. If anything is different, tick <b>Different</b>, write what you saw, and take a screenshot. Send me the scenario numbers and screenshots and I will fix them.", body)],
        [Paragraph("Offline billing only works in the finished (production) version of the app, so this test starts the app differently from <font name='Bold'>npm run dev</font>. It uses the test items from the Phase 8 hand test (Test Shirt ₹799, SKU TEST-799).", body)],
    ],
    colWidths=[170 * mm],
)
intro.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), TINT), ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
story += [intro, Spacer(1, 6)]

story.append(Paragraph("Setup (once)", h1))
story.append(
    scenario(
        "S",
        "Start the finished app",
        [
            "If <font name='Bold'>npm run dev</font> is running, stop it (Ctrl+C in its terminal).",
            "In the terminal type <font name='Bold'>npm run start:offline-check</font> and press Enter. It builds the app first (1-3 minutes). Wait for “Ready”.",
            "Open <font name='Bold'>http://localhost:3000</font> in Chrome and log in as the owner.",
        ],
        ["The app opens as usual.", "The menu has a new link: <font name='Bold'>Tills</font>."],
        "When you are finished with this test, stop it with Ctrl+C and go back to npm run dev.",
    )
)

story.append(Paragraph("A. Make this computer a till", h1))
story += [
    scenario(
        1,
        "Register this computer",
        [
            "Click <font name='Bold'>Tills</font>. Till name <font name='Bold'>Counter 1</font>, Branch: your main branch, Bill prefix <font name='Bold'>T1</font>. Click “Register this computer”.",
            "Click <font name='Bold'>New bill</font> in the menu.",
        ],
        ["“This computer is now the till Counter 1 (T1)…”", "Under Registered tills: Counter 1 (T1), last seen just now.", "On New bill, a strip at the top: “Counter 1 (T1) · Online · 0 waiting to sync”."],
    ),
]

story.append(Paragraph("B. Billing with no internet", h1))
story += [
    scenario(
        2,
        "Switch the Wi-Fi off and sell a shirt",
        [
            "Switch the computer's Wi-Fi off (Wi-Fi icon at the top right of the screen).",
            "On New bill press Cmd+R to reload the page.",
            "Type TEST-799 in the scan box and press Enter. Cash received <font name='Bold'>1000</font>. Click “Save bill offline (F9)”.",
        ],
        [
            "After the reload the page still opens; the strip says <font name='Bold'>Offline billing</font>.",
            "A receipt with a <font name='Bold'>PENDING SYNC</font> mark, “Tax invoice T1/26-27/00001”, total ₹799.00, Change ₹201.00.",
            "After “Next bill”: the strip says “1 waiting to sync”.",
        ],
        "If the strip does not say Offline billing after switching Wi-Fi off, click the “Bill offline” button on the strip.",
    ),
    scenario(
        3,
        "Take the shirt back (still offline)",
        [
            "Click the <font name='Bold'>Return (this till's bills)</font> tab. Click the bill T1/26-27/00001.",
            "Return quantity <font name='Bold'>1</font>. Money back by Cash. Reason: Testing offline return. Click “Save return offline”.",
        ],
        ["“Credit note T1R/26-27/00001”, Refund ₹799.00 by cash, PENDING SYNC.", "Strip: “2 waiting to sync”."],
    ),
    scenario(
        4,
        "Logging out warns about unsent bills",
        ["Click <font name='Bold'>Log out</font> (top right)."],
        ["A warning: “2 bill(s) or return(s) on this till are not sent yet…”", "Click <font name='Bold'>Stay logged in</font> (do not log out)."],
    ),
]

story.append(Paragraph("C. The internet comes back", h1))
story += [
    scenario(
        5,
        "Switch the Wi-Fi on",
        [
            "Switch the Wi-Fi on. Wait about 10 seconds on New bill.",
            "Click <font name='Bold'>Bills</font> in the menu.",
            "Click <font name='Bold'>Sync status</font> on the New bill strip.",
        ],
        [
            "The strip goes to “0 waiting to sync”, “Everything is sent.”",
            "Bills: <font name='Bold'>T1/26-27/00001</font> is there, ₹799.00 (and its return).",
            "Sync status: Waiting to sync 0, Failed 0; under Recently sent: the bill and the return.",
        ],
    ),
    scenario(
        6,
        "Stock is right",
        ["Click <font name='Bold'>Stock</font>."],
        ["Test Shirt · M is the same as before scenario 2 (one sold, one back)."],
    ),
]

story.append(Paragraph("D. A bill that no longer fits", h1))
story += [
    scenario(
        7,
        "Sell more than is in stock, offline",
        [
            "Note how many Test Jacket · L are in stock (Stock page). Call it N.",
            "Wi-Fi off. New bill: type TEST-1299, Enter, change Quantity to N + 1 (one more than in stock). Cash received: the total shown. Save bill offline.",
            "Wi-Fi on. Wait 10 seconds. Click <font name='Bold'>Tills</font>, then <font name='Bold'>Offline bills to check</font>.",
            "Type “Counted the shelf” in the box and click <font name='Bold'>Reviewed</font>.",
        ],
        [
            "The bill was saved offline (PENDING SYNC) and then sent.",
            "Offline bills to check: the bill, Counter 1, “Stock went below zero: Test Jacket…”.",
            "After Reviewed it moves under “Reviewed” with your note. Stock shows Test Jacket at −1.",
        ],
        "Correct the jacket stock afterwards with Stock → Adjust (in, Found, 1) so later tests start from 0.",
    ),
]

story.append(Paragraph("E. A lost till", h1))
story += [
    scenario(
        8,
        "Revoke the till",
        [
            "Tills → next to Counter 1 click <font name='Bold'>Revoke</font>.",
            "Click <font name='Bold'>New bill</font>, then “Sync status” on the strip, then <font name='Bold'>Sync now</font>.",
            "Click <font name='Bold'>Remove this till's data</font>.",
        ],
        [
            "Tills: Counter 1 shows “revoked”.",
            "Sync status: “This till was revoked by a manager.” and “Nothing is waiting to be sent.”",
            "“This computer's till data was removed. It is no longer a till.” New bill now says the computer is not a registered till.",
        ],
        "In a real shop, if something was not sent, “Save unsent items as a file” appears first; give that file to the owner.",
    ),
]

story.append(Paragraph("Final check", h1))
story.append(
    scenario(
        "F",
        "Register again for real use (optional)",
        ["Tills → register this computer again with a NEW prefix (e.g. <font name='Bold'>T2</font>; T1 can never be used again)."],
        ["“This computer is now the till … (T2)”."],
        "Stop the app with Ctrl+C when finished, and start npm run dev again for normal work.",
    )
)

# A section title always starts on the same page as its first scenario.
merged = []
for flowable in story:
    if merged and isinstance(flowable, KeepTogether) and isinstance(merged[-1], Paragraph) and merged[-1].style is h1:
        heading = merged.pop()
        flowable = KeepTogether([heading, *flowable._content])
    merged.append(flowable)
story = merged

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm, title="Phase 10 hand test", author="Billing app")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("written", OUT)
