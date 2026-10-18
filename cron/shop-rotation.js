// shop-rotation helper (can be converted to cloud function)
const { rotateShopNow } = require('../index');

module.exports = {
  run: () => rotateShopNow()
};
