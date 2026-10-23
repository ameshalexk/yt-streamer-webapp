import test from "node:test";
import assert from "node:assert/strict";
import { investmentAllocation } from "../src/lib/money-dashboard.js";

const assets = [
  { id: "robinhood", value: 30_000 },
  { id: "fidelity", value: 100_000 },
  { id: "etrade", value: 53_000 },
  { id: "401k", value: 416_856 },
  { id: "529", value: 32_388 },
  { id: "cash", value: 233_670 },
  { id: "hsa", value: 25_000 },
  { id: "tesla", value: 40_000 },
];

test("estimated investment mix excludes assets of unknown composition and respects 60% illustration", () => {
  const allocation = investmentAllocation(assets);
  assert.equal(allocation.current.total, 865_914);
  assert.ok(allocation.current.stockPct > 71 && allocation.current.stockPct < 73);
  assert.ok(allocation.current.bondPct > 0.9 && allocation.current.bondPct < 1.2);
  assert.equal(allocation.proposal.executed, false);
  assert.equal(allocation.proposal.principalPayment, 45_500);
  assert.equal(allocation.proposal.emergencySavingsTransfer, 69_954);
  assert.ok(allocation.scenario.stockPct <= 60);
  assert.ok(allocation.scenario.stockPct > 59);
  assert.equal(allocation.scenario.total, allocation.current.total - 45_500);
  assert.equal(allocation.scenario.cash, 188_170);
});

test("empty portfolio is safe and has no hypothetical exchange", () => {
  const allocation = investmentAllocation([]);
  assert.equal(allocation.current.total, 0);
  assert.equal(allocation.proposal.retirementExchange, 0);
  assert.equal(allocation.proposal.principalPayment, 0);
  assert.equal(allocation.scenario.total, 0);
});

test("reallocations are computed from the latest account values, not fixed percentages", () => {
  const allocation = investmentAllocation(assets.map((a) => a.id === "401k" ? { ...a, value: 300_000 } : a));
  assert.equal(allocation.current.total, 749_058);
  assert.ok(allocation.proposal.retirementExchange < 133_000);
});
