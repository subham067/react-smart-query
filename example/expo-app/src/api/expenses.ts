import { AnyItem } from 'react-smart-query';

export interface Expense extends AnyItem {
  id: string;
  amount: number;
  description: string;
  category: string;
  createdAt: number;
  updatedAt: number;
}

const MOCK_EXPENSES: Expense[] = Array.from({ length: 50 }, (_, i) => ({
  id: `exp_${i + 1}`,
  amount: Math.floor(Math.random() * 1000),
  description: `Lunch ${i + 1}`,
  category: "Food",
  createdAt: Date.now() - i * 1000 * 60 * 60, // each 1h apart
  updatedAt: Date.now() - i * 1000 * 60 * 60,
})).sort((a, b) => b.createdAt - a.createdAt);

export interface ExpenseResponse {
  items: Expense[];
  nextCursor: string | null;
}

export const fetchExpenses = async (cursor?: string, limit = 10): Promise<ExpenseResponse> => {
  // Simulate network latency
  await new Promise(r => setTimeout(r, 800));

  const startIndex = cursor ? MOCK_EXPENSES.findIndex(e => e.id === cursor) : 0;
  if (startIndex === -1) return { items: [], nextCursor: null };

  const items = MOCK_EXPENSES.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + limit < MOCK_EXPENSES.length 
    ? MOCK_EXPENSES[startIndex + limit].id 
    : null;

  return { items, nextCursor };
};
