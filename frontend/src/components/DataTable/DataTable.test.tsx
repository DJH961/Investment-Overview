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
