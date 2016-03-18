var express = require('express');
var router = express.Router();
router.preferredBase = '/slack';

/* GET users listing. */
router.get('/', function(req, res, next) {
  const db = req.app.get('db');
  db.get('users').find({}, (err, docs) => {
    if (err) {
      return next(err);
    }
    res.send(docs);
  });
});

module.exports = router;
