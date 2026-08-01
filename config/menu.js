const MENU = {
  beer: {
    id: 'beer',
    name: 'Beer',
    price: Number(process.env.PRICE_BEER || 390)
  },
  regency: {
    id: 'regency',
    name: 'Regency',
    price: Number(process.env.PRICE_REGENCY || 590)
  }
};

function getMenu() {
  return Object.values(MENU);
}

function priceOf(itemId) {
  const item = MENU[itemId];
  if (!item) {
    throw new Error(`Unknown menu item: ${itemId}`);
  }
  return item.price;
}

function nameOf(itemId) {
  return MENU[itemId].name;
}

module.exports = { MENU, getMenu, priceOf, nameOf };
