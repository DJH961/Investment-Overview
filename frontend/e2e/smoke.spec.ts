import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-test-password-12345";
const FIXTURE = resolve(import.meta.dirname, "../../backend/tests/adapters/fixtures/vanguard_sample.csv");

async function login(page: Page) {
  await page.addInitScript(() => localStorage.setItem("iv.tour.seen", "1"));
  await page.goto("/login");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/overview/);
}

test("login, import a broker file, see transactions", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Overview" }).first()).toBeVisible();

  const created = await page.request.post("/api/accounts", {
    headers: { Origin: new URL(page.url()).origin },
    data: { account_label: "E2E Vanguard", broker: "vanguard", native_currency: "USD", account_type: "brokerage" },
  });
  expect(created.status()).toBe(201);

  await page.goto("/import");
  await page.getByLabel("Broker file").setInputFiles(FIXTURE);
  await page.getByRole("combobox", { name: "Account" }).click();
  await page.getByRole("option", { name: /E2E Vanguard/ }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/Preview - vanguard_sample\.csv/)).toBeVisible();
  await page.getByRole("button", { name: /^Import \d+ transactions$/ }).click();
  await expect(page.getByText(/Imported \d+ transactions/).first()).toBeVisible();

  await page.goto("/transactions");
  await expect(page.getByText("VTI").first()).toBeVisible();
});

test("phone viewport shows the tab bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page);
  await expect(page.getByRole("navigation", { name: "Main tabs" })).toBeVisible();
});

test("tour shows on first visit and can be skipped", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Welcome to Investment Overview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Welcome to Investment Overview")).toBeHidden();
});
