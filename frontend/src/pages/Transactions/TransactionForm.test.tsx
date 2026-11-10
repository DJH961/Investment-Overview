import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TransactionForm } from "./TransactionForm";

vi.mock("../../lib/queries/transactions-extra", () => ({
  reconcileTrade: vi.fn(async () => ({ filled: null, error: null })),
}));

const ACCOUNTS = [{ value: "1", label: "Fake account" }];

function setup(onSubmit = vi.fn()) {
  render(
    <TransactionForm row={null} accounts={ACCOUNTS} busy={false} serverError={null} onSubmit={onSubmit} onCancel={() => undefined} />,
  );
  return onSubmit;
}

describe("TransactionForm", () => {
  it("renders the trade fields and saves a dot-decimal body from comma input", () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "fake1" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "12,5" } });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "1.234,56" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    const body = onSubmit.mock.calls[0][0];
    expect(body).toMatchObject({ account_id: 1, kind: "buy", symbol: "FAKE1", quantity: "12.5", price: "1234.56", total: null });
  });

  it("never turns invalid input into 0: it shows an error and does not submit", () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a non-negative number/)).toBeInTheDocument();
  });

  it("rejects negative amounts", () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText("Fees"), { target: { value: "-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("hides trade fields for a deposit row", () => {
    render(
      <TransactionForm
        row={{ account_id: 1, kind: "deposit", date: "2026-01-02" } as never}
        accounts={ACCOUNTS}
        busy={false}
        serverError={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("Quantity")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Amount (native)")).toBeInTheDocument();
  });
});
