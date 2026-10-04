"""Phase 8 hand test checklist as a printable PDF (A4).

Developer tool, not part of the app. Needs Python with reportlab (and macOS
fonts SF Pro and Arial Bold, for the rupee sign):
    python3 -m venv /tmp/pdfenv && /tmp/pdfenv/bin/pip install reportlab
    /tmp/pdfenv/bin/python docs/hand-tests/make_phase8_pdf.py docs/hand-tests/phase-8-hand-test.pdf
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
    canvas.drawString(20 * mm, 12 * mm, "Billing app · Phase 8 hand test · returns, exchanges, payments, expenses")
    canvas.drawRightString(190 * mm, 12 * mm, f"Page {doc.page}")
    canvas.restoreState()


story = [
    Paragraph("Phase 8 hand test", title),
    Paragraph("Returns, credit notes, exchanges, customer payments, returns to suppliers and expenses. 20 scenarios, about 45 minutes. Do them in order: later scenarios use what earlier ones created, and the numbers below assume that.", subtitle),
]

intro = Table(
    [
        [Paragraph("<font name='Bold'>How to use this</font>", body)],
        [Paragraph("Tick <b>Passed</b> when the screen shows exactly what is written. If anything is different, tick <b>Different</b>, write what you saw, and take a screenshot. Send me the scenario numbers and screenshots and I will fix them.", body)],
        [Paragraph("All amounts assume the two test items from the setup below (₹799 and ₹1,299, TEST 5% GST, prices include GST). Bill and credit note numbers depend on what you made before, so only check that they go up by one.", body)],
    ],
    colWidths=[170 * mm],
)
intro.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), TINT), ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
story += [intro, Spacer(1, 6)]

story.append(Paragraph("Setup (once)", h1))
story.append(
    scenario(
        "S",
        "Start the app and make two test items",
        [
            "In the terminal type <font name='Bold'>npm run dev</font> and press Enter. Wait for “Ready”. Open http://localhost:3000 and log in as the owner.",
            "Products → New product. Product name <font name='Bold'>Test Shirt</font>, Unit “Piece (pcs)”, Tax rate “TEST 5%”. Variant 1: SKU <font name='Bold'>TEST-799</font>, Size M, Selling price 799. Save product.",
            "Products → New product again: <font name='Bold'>Test Jacket</font>, same unit and tax rate, SKU <font name='Bold'>TEST-1299</font>, Size L, Selling price 1299. Save product.",
            "Stock → Opening stock. Line 1: SKU TEST-799, Quantity 30, Cost 400. Click “Add a line”. Line 2: SKU TEST-1299, Quantity 10, Cost 700. Save opening stock.",
        ],
        ["“Opening stock saved (2 lines).”", "Stock page: Test Shirt · M = <font name='Bold'>30</font>, Test Jacket · L = <font name='Bold'>10</font>."],
        "Business settings must say “Registered (regular)” with your GSTIN (done in Phase 7). Otherwise bills will say “Bill of Supply”.",
    )
)

story.append(Paragraph("A. Returns and credit notes", h1))
story += [
    scenario(
        1,
        "Sell 2 shirts, return 1 for cash",
        [
            "New bill. Type TEST-799 in the scan box, press Enter. Change Quantity to 2. Cash received 1598. Save bill (F9).",
            "On the bill, click <font name='Bold'>Return items</font>. Return now: 1. Leave “Can be sold again” ticked. Money goes back as: Cash. Reason: Testing return. Save return.",
        ],
        ["The bill total was ₹1,598.00.", "A <font name='Bold'>Credit Note</font> (CN/…), “Refund ₹799.00”, “Paid back as Cash”.", "Stock: Test Shirt = 29."],
    ),
    scenario(
        2,
        "Return the other shirt",
        ["Click “← Bill …” at the top. Return items again. The line shows Sold 2, Already back 1. Return now: 1, Cash, reason Testing return. Save return."],
        ["A second credit note, refund ₹799.00. The two refunds together = ₹1,598.00, the bill total.", "Stock: Test Shirt = 30."],
    ),
    scenario(
        3,
        "Try to return a third shirt",
        ["Go back to the bill. Click Return items."],
        ["“Everything on this bill has already been returned.”", "The bill lists both returns under “Returns against this bill”."],
    ),
    scenario(
        4,
        "A damaged item",
        [
            "New bill: TEST-799, quantity 1, Cash received 799. Save bill.",
            "Return items: Return now 1, <font name='Bold'>untick</font> “Can be sold again”. Cash. Reason: Torn. Save return.",
        ],
        ["Credit note refund ₹799.00; the line says “damaged”.", "Stock: Test Shirt = 29 (the torn shirt does not go back on the shelf)."],
    ),
]

story.append(Paragraph("B. Customers: credit, store credit, payments", h1))
story += [
    scenario(
        5,
        "A customer buys on credit",
        [
            "Customers. Add a customer: name <font name='Bold'>Test Credit A</font>, phone 90000 00001, credit limit 2000. Add customer.",
            "New bill: TEST-799, quantity 1. Customer: type 00001, Find, click Test Credit A. Leave all payments empty. Save bill.",
        ],
        ["On the till before saving: “On the customer's account ₹799.00”.", "The bill: “Bill to: Test Credit A”, “On account ₹799.00”.", "Customers → Test Credit A: “Owes ₹799.00”. Stock: Test Shirt = 28."],
    ),
    scenario(
        6,
        "Return it as store credit",
        ["On Test Credit A's page, click that bill. Return items: 1, Money goes back as: <font name='Bold'>Store credit</font>. Reason: Testing store credit. Save return."],
        ["Credit note “Paid back as Store credit (customer's account)”, ₹799.00.", "Test Credit A: “Owes nothing”. Stock: Test Shirt = 29."],
    ),
    scenario(
        7,
        "A payment when nothing is owed",
        ["On Test Credit A's page, Take a payment: Amount 500, Method UPI, Reference UPI test. Save payment."],
        ["“Payment saved.” The payment appears under Payments.", "Balance: <font name='Bold'>Advance</font> ₹500.00."],
    ),
    scenario(
        8,
        "Part paid, part on credit",
        [
            "Add a customer: <font name='Bold'>Test Credit B</font>, phone 90000 00002, credit limit 2000.",
            "New bill: TEST-799 quantity 2, customer Test Credit B, Cash received 1000. Save bill.",
        ],
        ["Till before saving: “On the customer's account ₹598.00”.", "Test Credit B: “Owes ₹598.00”. Stock: Test Shirt = 27."],
    ),
    scenario(
        9,
        "A walk-in bill cannot get store credit",
        [
            "New bill: TEST-799 quantity 1, no customer, Cash received 799. Save bill.",
            "Return items. Open the “Money goes back as” list.",
            "Choose Cash, quantity 1, reason Walk-in test. Save return.",
        ],
        ["The list shows only Cash, UPI and Card (no Store credit).", "Refund ₹799.00. Stock: Test Shirt = 27."],
    ),
]

story.append(Paragraph("C. Exchanges", h1))
story += [
    scenario(
        10,
        "Same price swap",
        [
            "New bill: TEST-799 quantity 1, Cash received 799. Save bill.",
            "On the bill, click <font name='Bold'>Exchange</font>. Return quantity of Test Shirt: 1.",
            "In “Scan or type the new item's SKU” type TEST-799 and press Enter. Reason: Size swap. Save exchange.",
        ],
        [
            "Before saving: Value coming back ₹799.00, New bill ₹799.00, Customer pays ₹0.00, Customer gets back ₹0.00.",
            "A new Tax Invoice paid by <font name='Bold'>“Exchange (returned items)”</font> ₹799.00. Stock: Test Shirt = 26.",
        ],
    ),
    scenario(
        11,
        "Two back, one out: money back",
        [
            "New bill: TEST-799 quantity 2, Cash received 1598. Save bill.",
            "Exchange: return 2. New item TEST-799 (Enter). Give back as: Cash. Reason: Bought one too many. Save exchange.",
            "Open the first bill again (Bills → that bill).",
        ],
        [
            "Before saving: coming back ₹1,598.00, new bill ₹799.00, Customer gets back ₹799.00.",
            "New bill “Paid by Exchange (returned items) ₹799.00”.",
            "First bill, Returns: “₹1,598.00: ₹799.00 exchanged for new items, ₹799.00 refunded (Cash)”. Stock: Test Shirt = 25.",
        ],
    ),
    scenario(
        12,
        "Swap for a dearer item",
        [
            "New bill: TEST-799 quantity 1, Cash received 799. Save bill.",
            "Exchange: return 1 shirt. New item TEST-1299 (Enter). Cash received 500. Reason: Wants the jacket. Save exchange.",
        ],
        [
            "Before saving: coming back ₹799.00, new bill ₹1,299.00, <font name='Bold'>Customer pays</font> ₹500.00.",
            "New bill: Paid by Exchange (returned items) ₹799.00 and Paid by Cash ₹500.00.",
            "Stock: Test Shirt = 25, Test Jacket = 9.",
        ],
    ),
    scenario(
        13,
        "No void after a return",
        ["Open the bill from scenario 1 (Bills, today)."],
        ["Buttons “Return items” and “Exchange”, but <font name='Bold'>no Void</font> section."],
    ),
    scenario(
        14,
        "No void for an exchange bill",
        ["Open the new bill made by the exchange in scenario 10."],
        ["No Void section (it was paid with returned items)."],
    ),
    scenario(
        15,
        "The 7-day return limit (do this on a later day)",
        ["Eight or more days after scenario 1, log in as a <font name='Bold'>cashier</font> and open an old bill → Return items → try to save a return. Then try the same as a manager."],
        ["Cashier: “The return period for this bill has passed. Ask a manager.”", "Manager: the return saves; the credit note says “after the return period, approved by a manager”."],
        "You can leave this one for later and send me the result then.",
    ),
]

story.append(Paragraph("D. Returns to the supplier", h1))
story += [
    scenario(
        16,
        "Buy 10, send 4 back",
        [
            "Suppliers → Add a supplier: <font name='Bold'>Test Supplier</font>. Add supplier.",
            "New purchase from this supplier: bill number TS/1, line TEST-799, quantity 10, price 50, GST 5. Save purchase.",
            "On the purchase, click <font name='Bold'>Return goods to the supplier</font>. Quantity going back: 4. Reason: Damaged in transit. Send back.",
        ],
        [
            "Purchase bill total ₹525.00.",
            "“Goods sent back.” and “Sent back to the supplier: … ₹210.00 · Damaged in transit”. No Void purchase.",
            "Test Supplier: “We owe ₹315.00”. Stock: Test Shirt = 31.",
        ],
    ),
    scenario(
        17,
        "Send the other 6 back",
        ["Purchase TS/1 → Return goods to the supplier: quantity 6, reason Not needed. Send back. Then open Return goods again."],
        ["Test Supplier: “Settled”.", "“Everything on this bill has already gone back.” Stock: Test Shirt = 25."],
    ),
    scenario(
        18,
        "Return goods that were already paid for",
        [
            "New purchase from Test Supplier: bill TS/2, TEST-799 quantity 2, price 50, GST 5. Paid now: Amount 105, Method Cash. Save purchase.",
            "Return goods to the supplier: quantity 2, reason Wrong colour. Send back.",
        ],
        ["Purchase total ₹105.00, paid ₹105.00.", "Test Supplier: <font name='Bold'>Advance</font> ₹105.00 (they owe you). Stock: Test Shirt = 25."],
    ),
]

story.append(Paragraph("E. Expenses and who may do what", h1))
story += [
    scenario(
        19,
        "Record and void an expense",
        [
            "Click <font name='Bold'>Expenses</font>. Click “Add the usual categories…”.",
            "Record an expense: Category Rent, Amount 15000, Paid by Bank transfer, What for October rent. Save expense.",
            "In the list, on the October rent row, type a reason (Entered twice) and click Void.",
        ],
        ["After saving: total ₹15,000.00 and “Rent: ₹15,000.00”.", "After voiding: the row is crossed out with “Voided: Entered twice”; total back to ₹0.00 (if no other expenses this month)."],
    ),
    scenario(
        20,
        "An accountant only looks",
        [
            "Staff → invite a second email address of yours with role <font name='Bold'>Accountant</font>; accept the invitation from that inbox.",
            "In a private browser window, log in as the accountant. Open Expenses, then a bill from today, then Purchases.",
        ],
        ["Expenses: the list is there, but no “Record an expense” form and no Void buttons.", "A bill: no “Return items” or “Exchange” buttons. Purchases: no “Return goods to the supplier”."],
        "Skip if you have no second email address; the automatic browser tests check this too.",
    ),
]

story.append(Paragraph("Final check", h1))
story.append(
    scenario(
        "F",
        "Stock matches",
        ["Stock page."],
        ["Test Shirt · M = <font name='Bold'>25</font>, Test Jacket · L = <font name='Bold'>9</font>.", "If both match, everything above moved stock correctly."],
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

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm, title="Phase 8 hand test", author="Billing app")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("written", OUT)
