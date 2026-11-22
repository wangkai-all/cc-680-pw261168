/**
 * Predefined whole blocks for the masking probe.
 *
 * A probe block is a cartesian product of selected stores and items. Every
 * known rating inside that rectangle is temporarily withheld from training and
 * then reconstructed, which exposes whole-block failures that a random
 * cell-level holdout tends to hide.
 */
export function probePresets(dataset) {
  const coreStores = dataset.stores.filter((s) => s.block === 'core').slice(0, 6).map((s) => s.id);
  const coreItems = dataset.items.filter((i) => i.block === 'core').slice(0, 4).map((i) => i.id);
  const outletStores = dataset.stores.filter((s) => s.block === 'outlet').map((s) => s.id);
  const outletItems = dataset.items.filter((i) => i.block === 'outlet').map((i) => i.id);
  const highSupportStores = [...dataset.stores]
    .filter((s) => s.observedCount > 0)
    .sort((a, b) => b.observedCount - a.observedCount)
    .slice(0, 5)
    .map((s) => s.id);
  return [
    {
      id: 'flagship-core',
      label: '遮住 6 家旗舰店 × 前 4 个服务项',
      description: '高支撑区域的整块遮蔽；随机留点通常会低估这种整块缺失的难度。',
      storeIds: coreStores,
      itemIds: coreItems
    },
    {
      id: 'top-support',
      label: '遮住观测最多的 5 家门店 × 核心 4 项',
      description: '把最“好补”的区域整块拿走，观察其余格子是否还能维持估计。',
      storeIds: highSupportStores,
      itemIds: coreItems
    },
    {
      id: 'outlet-all',
      label: '遮住整个奥莱问卷块',
      description: '整块移除后，奥莱门店与项目没有训练观测，用于检验跨块无依据的提示。',
      storeIds: outletStores,
      itemIds: outletItems
    }
  ];
}
