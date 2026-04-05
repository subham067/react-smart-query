/**
 * example/expo-app/src/screens/ExpenseScreen.tsx
 *
 * Demonstrates useInfiniteSmartQuery with pagination and real-time mutations.
 */

import React, { useState, useCallback } from 'react';
import { 
  View, 
  Text, 
  FlatList, 
  StyleSheet, 
  TouchableOpacity, 
  ActivityIndicator, 
  Switch 
} from 'react-native';
import { useInfiniteSmartQuery } from 'smart-query';
import { fetchExpenses, Expense } from '../api/expenses';

export function ExpenseScreen() {
  const [isOffline, setIsOffline] = useState(false);

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
    addItem,
    updateItem,
    removeItem,
    totalCount
  } = useInfiniteSmartQuery<any, Expense>({
    queryKey: ['expenses'],
    queryFn: async ({ pageParam }) => {
      if (isOffline) throw new Error('Offline mode enabled');
      return fetchExpenses(pageParam as string);
    },
    getNextCursor: (res) => res.nextCursor,
    select: (res) => res.items,
    getItemId: (e) => e.id,
    sortComparator: (a, b) => b.createdAt - a.createdAt,
    pageSize: 10,
  });

  const onAddExpense = () => {
    const newExpense: Expense = {
      id: `new_${Date.now()}`,
      amount: Math.floor(Math.random() * 500),
      description: 'New Coffee',
      category: 'Food',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    addItem(newExpense);
  };

  const onUpdateExpense = (item: Expense) => {
    updateItem({
      ...item,
      amount: item.amount + 10,
      updatedAt: Date.now(),
    });
  };

  const renderItem = ({ item }: { item: Expense }) => (
    <View style={styles.card}>
      <View style={styles.cardContent}>
        <Text style={styles.description}>{item.description}</Text>
        <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity onPress={() => onUpdateExpense(item)} style={styles.btn}>
          <Text style={styles.btnText}>+$10</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => removeItem(item.id)} style={[styles.btn, styles.btnDanger]}>
          <Text style={styles.btnText}>Del</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Expenses ({totalCount})</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Offline Simulation</Text>
          <Switch value={isOffline} onValueChange={setIsOffline} />
        </View>
      </View>

      {isLoading ? (
        <ActivityIndicator style={styles.loader} size="large" color="#007AFF" />
      ) : (
        <FlatList
          data={Array.isArray(data) ? data : []}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          onEndReached={() => hasNextPage && fetchNextPage()}
          onEndReachedThreshold={0.5}
          contentContainerStyle={styles.list}
          ListFooterComponent={() => 
            isFetchingNextPage ? (
              <ActivityIndicator style={styles.footerLoader} />
            ) : null
          }
          onRefresh={refetch}
          refreshing={false}
        />
      )}

      <TouchableOpacity style={styles.fab} onPress={onAddExpense}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    padding: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#EEE',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: 22, fontWeight: '700', color: '#1A1A1A' },
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { marginRight: 10, fontSize: 14, color: '#666' },
  list: { padding: 15 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardContent: { flex: 1 },
  description: { fontSize: 16, fontWeight: '500', color: '#333' },
  amount: { fontSize: 18, fontWeight: '700', color: '#007AFF', marginTop: 4 },
  actions: { flexDirection: 'row' },
  btn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#E7F2FF',
    borderRadius: 6,
    marginLeft: 8,
  },
  btnDanger: { backgroundColor: '#FFE7E7' },
  btnText: { fontSize: 12, fontWeight: '600', color: '#007AFF' },
  loader: { flex: 1, justifyContent: 'center' },
  footerLoader: { marginVertical: 20 },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  fabText: { fontSize: 32, color: '#fff', fontWeight: 'bold' },
});
