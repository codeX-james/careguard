/**
 * React tests for BillsTab line-item sort control (Issue #1274).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { BillsTab } from "../components/tabs/bills-tab";
import type { AgentResult } from "../components/types";
import type { RecipientProfile, SpendingData } from "../lib/types";

const recipient: RecipientProfile = { name: "Rosa" };

const spending: SpendingData = {
  policy: {
    dailyLimit: 100,
    monthlyLimit: 500,
    medicationMonthlyBudget: 300,
    billMonthlyBudget: 500,
    approvalThreshold: 50,
    holdTimeSeconds: 86400,
  },
  spending: { medications: 0, bills: 0, serviceFees: 0, total: 0 },
  budgetRemaining: { medications: 300, bills: 500 },
  transactionCount: 0,
  recentTransactions: [],
};

function buildAgentResult(): AgentResult {
  return {
    response: "Audit complete",
    toolCalls: [
      {
        id: "call-1",
        tool: "audit_medical_bill",
        input: {},
        result: {
          totalCharged: 900,
          totalCorrect: 700,
          totalOvercharge: 200,
          errorCount: 2,
          recommendation: "Dispute the flagged items.",
          lineItems: [
            {
              description: "Small overcharge",
              cptCode: "111",
              chargedAmount: 120,
              status: "upcoded",
              suggestedAmount: 100,
            },
            {
              description: "Large overcharge",
              cptCode: "222",
              chargedAmount: 300,
              status: "duplicate",
              suggestedAmount: 150,
            },
            {
              description: "Valid line",
              cptCode: "333",
              chargedAmount: 80,
              status: "valid",
              suggestedAmount: 80,
            },
          ],
        },
      },
    ],
    spending,
  };
}

function descriptionOrder(): string[] {
  return screen
    .getAllByTestId("line-item")
    .map((el: HTMLElement) => el.querySelector(".font-medium")?.textContent || "");
}

describe("BillsTab — line item sort control (Issue #1274)", () => {
  it("keeps original order by default", () => {
    render(<BillsTab agentResult={buildAgentResult()} recipient={recipient} />);
    expect(descriptionOrder()).toEqual([
      "Small overcharge",
      "Large overcharge",
      "Valid line",
    ]);
  });

  it("sorts by overcharge amount descending when the sort control is toggled on", async () => {
    const user = userEvent.setup();
    render(<BillsTab agentResult={buildAgentResult()} recipient={recipient} />);
    await user.click(screen.getByRole("button", { name: /sort by overcharge/i }));
    expect(descriptionOrder()).toEqual([
      "Large overcharge",
      "Small overcharge",
      "Valid line",
    ]);
  });

  it("preserves the errors-only filter alongside sorting", async () => {
    const user = userEvent.setup();
    render(<BillsTab agentResult={buildAgentResult()} recipient={recipient} />);
    await user.click(screen.getByRole("button", { name: /sort by overcharge/i }));
    await user.click(screen.getByRole("button", { name: /show errors only/i }));
    expect(descriptionOrder()).toEqual(["Large overcharge", "Small overcharge"]);
  });

  it("returns to default order when sort is toggled back off", async () => {
    const user = userEvent.setup();
    render(<BillsTab agentResult={buildAgentResult()} recipient={recipient} />);
    const sortBtn = screen.getByRole("button", { name: /sort by overcharge/i });
    await user.click(sortBtn);
    await user.click(screen.getByRole("button", { name: /default order/i }));
    expect(descriptionOrder()).toEqual([
      "Small overcharge",
      "Large overcharge",
      "Valid line",
    ]);
  });
});
