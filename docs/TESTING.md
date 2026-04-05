# Testing & Debugging with React Smart Query

Testing offline-first normalized data layers can be tricky, but `react-smart-query` provides dedicated utilities to make it painless.

## 1. Setting up the Test Environment

When testing components that use `useSmartQuery` or `useInfiniteSmartQuery`, you should wrap them in the `SmartQueryTestProvider` rather than standard QueryClientProviders. This ensures the internal registry and normalization engines are securely isolated per test.

### Installation
Make sure you import from the designated `testing` entry point, ensuring test tools aren't bundled into production:
```tsx
import { render } from '@testing-library/react-native';
import { SmartQueryTestProvider } from 'react-smart-query/testing';

const renderWithProvider = (ui: React.ReactElement) => {
  return render(
    <SmartQueryTestProvider>
      {ui}
    </SmartQueryTestProvider>
  );
};
```

## 2. Seeding Data
Oftentimes, you want to test how a component behaves *given* some pre-existing cached state, without mocking the network layer heavily. You can seed the cache directly inside your tests using the `seedCache` utility.

```tsx
import { SmartQueryTestProvider, seedCache } from 'react-smart-query/testing';

beforeEach(() => {
  seedCache(['expenses', 'user-123'], [
    { id: '1', amount: 50, desc: 'Coffee' },
    { id: '2', amount: 120, desc: 'Groceries' }
  ]);
});

test('renders expenses from cache directly', () => {
  const { getByText } = renderWithProvider(<ExpenseList userId="user-123" />);
  expect(getByText('Coffee')).toBeTruthy();
});
```

## 3. The Debugger
If you ever find yourself wondering exactly what's sitting in the `react-smart-query` internal normalization maps, you can use the built in debugger. We highly recommend only tying this to `__DEV__`.

### Activating the Debugger
In your root file (like App.tsx):
```tsx
if (__DEV__) {
  require('react-smart-query/debug');
}
```

### Retrieving Snapshots
Once activated, you can trigger snapshots to the console representing the current entire data map and state.
```tsx
import { smartQueryDebug } from 'react-smart-query';

// From a component effect, or attached to a dev-only button:
await smartQueryDebug.snapshot();
```
