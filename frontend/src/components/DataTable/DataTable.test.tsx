import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DataTable, type Column } from "./DataTable";

interface Row {
  id: string;
  name: string;
  value: number;
}

const rows: Row[] = [
  { id: "a", name: "Bravo", value: 20 },
  { id: "b", name: "Alpha", value: 30 },
  { id: "c", name: "Charlie", value: 10 },
];

const columns: Column<Row>[] = [
  { key: "name", header: "Name", primary: true, cell: (r) => r.name, sortValue: (r) => r.name },
  { key: "value", header: "Value", align: "right", cell: (r) => r.value, sortValue: (r) => r.value },
];

function names(): string[] {
  const body = screen.getAllByRole("rowgroup")[1];
  return within(body)
    .getAllByRole("row")
    .map((r) => within(r).getAllByRole("cell")[0].textContent ?? "");
}

describe("DataTable", () => {
  it("sorts by a column and toggles direction", async () => {
    render(<DataTable caption="Test" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(names()).toEqual(["Bravo", "Alpha", "Charlie"]);
    await userEvent.click(screen.getByRole("button", { name: /Value/ }));
    expect(names()).toEqual(["Charlie", "Bravo", "Alpha"]);
    await userEvent.click(screen.getByRole("button", { name: /Value/ }));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
  it("honours the default sort and shows an empty message", () => {
    const { rerender } = render(
      <DataTable
        caption="Test"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        defaultSort={{ key: "value", direction: "desc" }}
      />,
    );
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    rerender(<DataTable caption="Test" columns={columns} rows={[]} rowKey={(r: Row) => r.id} emptyMessage="Nada" />);
    expect(screen.getByText("Nada")).toBeInTheDocument();
  });
});

describe("DataTable phone markup", () => {
  it("labels non-primary cells, marks hidden columns and keeps numbers on one line", () => {
    const cols: Column<Row>[] = [
      { key: "value", header: "Value", align: "right", cell: (r) => `€${r.value},000.00` },
      { key: "name", header: "Name", primary: true, cell: (r) => r.name },
      { key: "src", header: "Source", phone: "hide", cell: () => "csv" },
    ];
    render(<DataTable caption="Test" columns={cols} rows={rows.slice(0, 1)} rowKey={(r) => r.id} />);
    const body = screen.getAllByRole("rowgroup")[1];
    const cells = within(body).getAllByRole("cell");
    // value cell: inline label + nowrap value
    expect(cells[0].querySelector(".data-table__label")?.textContent).toBe("Value");
    expect(cells[0].querySelector(".data-table__value--nowrap")?.textContent).toBe("€20,000.00");
    // primary cell: no label, gets the primary modifier (CSS orders it first)
    expect(cells[1]).toHaveClass("data-table__td--primary");
    expect(cells[1].querySelector(".data-table__label")).toBeNull();
    // low-priority column is flagged for phones, header too
    expect(cells[2]).toHaveClass("data-table__td--phone-hidden");
    expect(screen.getByRole("columnheader", { name: "Source" })).toHaveClass("data-table__th--phone-hidden");
  });
});

describe("DataTable footer", () => {
  it("renders a footer row inside the table aligned with columns and respects phoneKeys", () => {
    const cols: Column<Row>[] = [
      { key: "name", header: "Name", primary: true, cell: (r) => r.name },
      { key: "start", header: "Start", align: "right", phone: "hide", group: "Val", cell: (r) => r.value },
      { key: "hidden", header: "Secret", align: "right", phone: "hide", cell: () => "x" },
      { key: "value", header: "Total", align: "right", phone: "headline", cell: (r) => r.value },
      { key: "extra", header: "Extra", align: "right", cell: () => "10%" },
    ];
    render(
      <DataTable
        caption="Summary"
        columns={cols}
        rows={rows.slice(0, 1)}
        rowKey={(r) => r.id}
        footer={{
          ariaLabel: "Summary total",
          phoneKeys: ["start"],
          cells: {
            name: "Total",
            start: "€100.00",
            hidden: "skip",
            value: "+€20.00",
          },
        }}
      />,
    );

    const table = screen.getByRole("table", { name: "Summary" });
    const foot = within(table).getByLabelText("Summary total");
    expect(foot.tagName).toBe("TFOOT");

    const rowHeader = within(foot).getByRole("rowheader", { name: "Total" });
    expect(rowHeader).toHaveAttribute("scope", "row");
    expect(rowHeader).toHaveClass("data-table__foot-cell--primary", "data-table__foot-cell--emphasis");

    const cells = within(foot).getAllByRole("cell");
    // start: phone: "hide", but listed in phoneKeys -> shown with label and group-start
    expect(cells[0]).toHaveClass("data-table__foot-cell--right", "data-table__foot-cell--group-start");
    expect(cells[0]).not.toHaveClass("data-table__foot-cell--phone-hidden");
    expect(cells[0].querySelector(".data-table__label")?.textContent).toBe("Start");
    expect(cells[0].querySelector(".data-table__value--nowrap")?.textContent).toBe("€100.00");

    // hidden: phone: "hide", not in phoneKeys -> hidden on phones
    expect(cells[1]).toHaveClass("data-table__foot-cell--phone-hidden");

    // headline cell: no label, right-aligned, emphasized
    expect(cells[2]).toHaveClass("data-table__foot-cell--headline", "data-table__foot-cell--emphasis");
    expect(cells[2].querySelector(".data-table__label")).toBeNull();
    expect(cells[2].querySelector(".data-table__value")?.textContent).toBe("+€20.00");

    // omitted footer cell: marked empty so phones skip it cleanly without a label
    expect(cells[3]).toHaveClass("data-table__foot-cell--empty");
    expect(cells[3].querySelector(".data-table__label")).toBeNull();
  });

  it("omits the footer when rows are empty or loading", () => {
    const { rerender } = render(
      <DataTable
        caption="Empty"
        columns={columns}
        rows={[]}
        rowKey={(r: Row) => r.id}
        footer={{ ariaLabel: "Summary total", cells: { name: "Total", value: 0 } }}
      />,
    );
    expect(screen.queryByLabelText("Summary total")).not.toBeInTheDocument();

    rerender(
      <DataTable
        caption="Loading"
        columns={columns}
        rows={rows}
        loading
        rowKey={(r) => r.id}
        footer={{ ariaLabel: "Summary total", cells: { name: "Total", value: 60 } }}
      />,
    );
    expect(screen.queryByLabelText("Summary total")).not.toBeInTheDocument();
  });
});
