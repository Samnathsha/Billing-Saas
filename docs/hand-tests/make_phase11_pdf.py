"""Phase 11 hand test checklist (security and your data) as a printable PDF (A4).

Developer tool, not part of the app. Needs Python with reportlab (and macOS
fonts SF Pro and Arial Bold, for the rupee sign):
    python3 -m venv /tmp/pdfenv && /tmp/pdfenv/bin/pip install reportlab
    /tmp/pdfenv/bin/python docs/hand-tests/make_phase11_pdf.py docs/hand-tests/phase-11-hand-test.pdf
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
    canvas.drawString(20 * mm, 12 * mm, "Billing app · Phase 11 hand test · security and your data")
    canvas.drawRightString(190 * mm, 12 * mm, f"Page {doc.page}")
    canvas.restoreState()




story = [
    Paragraph("Phase 11 hand test", title),
    Paragraph("Two-step login, the security emails, downloading your business's data, the deletion request (and cancelling it), and the draft legal pages. 6 scenarios, about 20 minutes. You need your phone.", subtitle),
]

intro = Table(
    [
        [Paragraph("<font name='Bold'>How to use this</font>", body)],
        [Paragraph("Tick <b>Passed</b> when the screen shows exactly what is written. If anything is different, tick <b>Different</b>, write what you saw, and take a screenshot.", body)],
        [Paragraph("Use your normal development app (<font name='Bold'>npm run dev</font>, http://localhost:3000), logged in as the owner. Scenario 4 asks to delete the business and then cancels it at once: <font name='Bold'>do not skip the cancel</font>.", body)],
    ],
    colWidths=[170 * mm],
)
intro.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), TINT), ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
story += [intro, Spacer(1, 6)]

story.append(Paragraph("A. Two-step login", h1))
story += [
    scenario(
        1,
        "Switch on two-step login",
        [
            "On your phone, install <font name='Bold'>Google Authenticator</font> (or Microsoft Authenticator).",
            "In the app menu click <font name='Bold'>Two-step login</font>. Enter your password, click “Set up two-step login”.",
            "In the phone app: add an account → scan QR code → scan the code on the screen.",
            "Type the 6-digit code the phone shows and click “Turn on two-step login”.",
            "Write the 10 backup codes on paper (or save them in your password manager), then click “I have saved them”.",
        ],
        ["“Two-step login is on.” with 10 backup codes.", "An email “Two-step login is now on” arrives in your inbox."],
    ),
    scenario(
        2,
        "Log in with the code",
        [
            "Click <font name='Bold'>Log out</font>. Log in with your email and password.",
            "Type a wrong code, e.g. 123456, and click Log in.",
            "Type the code your phone shows now and click Log in.",
        ],
        ["After the password: “Open your authenticator app and enter the 6-digit code…”.", "Wrong code: “That code is not right…”.", "Right code: you are in the app."],
        "Lost phone? “Use a backup code instead” on the same screen; each backup code works once.",
    ),
]

story.append(Paragraph("B. Your business's data", h1))
story += [
    scenario(
        3,
        "Download everything",
        [
            "Menu → <font name='Bold'>Business settings</font> → scroll to “Your business's data”.",
            "Click “Download all data (ZIP)”. Open the downloaded ZIP; open <font name='Bold'>invoices.csv</font> in Excel or Numbers.",
        ],
        ["A file business-export-YYYY-MM-DD.zip with README.txt and one .csv file per kind of record.", "invoices.csv lists your test bills (amounts in paise: 79900 = ₹799.00)."],
        "Clicking again within 10 minutes says to wait: exports are limited and recorded in the audit log.",
    ),
    scenario(
        4,
        "Ask to delete, then cancel at once",
        [
            "Same section: in “To confirm, type the name exactly”, type your business name exactly as shown. Click “Ask to delete this business”.",
            "Look at the top of any page.",
            "Back in Business settings click <font name='Bold'>Cancel the deletion</font>.",
        ],
        ["A red banner on every page: “This business will be deleted on <date 30 days from now>…”.", "After Cancel: the banner is gone, and the form shows “Ask to delete this business” again."],
        "Deletion only happens 30 days later AND only when the operator runs the purge script by hand. Cancelling stops it completely.",
    ),
]

story.append(Paragraph("C. Other checks", h1))
story += [
    scenario(
        5,
        "Password field and draft legal pages",
        [
            "Log out. On the login page click <font name='Bold'>Show</font> next to the password box.",
            "At the bottom of the login card click <font name='Bold'>Terms</font>, then <font name='Bold'>Privacy</font>.",
        ],
        ["Show reveals what you typed (Hide hides it again).", "Both pages open with an orange “DRAFT for review by a lawyer” note and blanks in [brackets]."],
        "Give both pages to your lawyer (open questions 51 and 52 in docs/business-rules.md).",
    ),
    scenario(
        6,
        "Switch two-step login off (optional)",
        ["Log in (with the code). Menu → Two-step login. Enter your password, click “Turn off two-step login”."],
        ["The page says it is off, and an email “Two-step login was turned off” arrives."],
        "For the real shop we recommend keeping it ON for the owner and admins (open question 49).",
    ),
]

# A section title always starts on the same page as its first scenario.
merged = []
for flowable in story:
    if merged and isinstance(flowable, KeepTogether) and isinstance(merged[-1], Paragraph) and merged[-1].style is h1:
        heading = merged.pop()
        flowable = KeepTogether([heading, *flowable._content])
    merged.append(flowable)
story = merged

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm, title="Phase 11 hand test", author="Billing app")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("written", OUT)
