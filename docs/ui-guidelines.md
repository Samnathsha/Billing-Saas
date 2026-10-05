# UI guidelines

Short rules every screen follows, from the UX review (2026-10-05).

- **One main action per page**: a filled button (`action-primary` class),
  top right of the page header, e.g. "New product", "New bill". Other
  links in the header stay plain underlined text.
- **Short choices in groups**: never more than about 5 options in one row.
  Group longer lists under a small heading (menu: Sell, Stock, Money,
  Settings; reports: Sales, Money, Stock, GST).
- **Totals**: use a totals card (`<dl className="totals ...">`) so each
  label sits on the same row as its amount.
- **Tables** go inside `<div className="table-scroll">` so they scroll
  inside their own box on a phone.
- **Disabled buttons say why**: when a main button cannot be pressed, show
  one line of text under it with the reason (see "Save bill").
- **No dead ends**: an empty page that needs something else first shows a
  button to the page where you make it ("Go to Suppliers").
- **Touch**: on phones, buttons and fields are at least 40px tall; fields in
  forms sit in a 2-column grid on phones, 4 on wider screens.
- **Errors** are red text with `role="alert"`, placed next to what caused
  them, in plain words.
