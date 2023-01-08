import { test } from 'vitest';

test('mutations', async () => {
  /*  const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      initializedWithLoaded: ['users'],
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useListQuery({ tableId: 'users' });

      renders.add(pick(selectionResult, ['status', 'payload', 'items']));
    });

    async function actionWithOptimisticUpdateAndRevalidation(
      itemId: string,
      newText: string,
    ) {
      const endMutation = listQueryStore.startMutation(itemId);

      listQueryStore.updateItemState('1', (draftData) => {
        draftData.title = newText;
      });

      try {
        const result = await serverMock.emulateMutation({
          '1': { title: newText, completed: false },
        });

        endMutation();

        return result;
      } catch (e) {
        endMutation();

        return false;
      } finally {
        listQueryStore.invalidateData(itemId);
      }
    }

    actionWithOptimisticUpdateAndRevalidation('1', 'was updated');

    await sleep(150);

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 1 -- data: {title:todo, completed:false}
      status: success -- payload: 1 -- data: {title:was updated, completed:false}
      "
    `); */
});
