var express = require('express');
var router = express.Router();
var util = require('util');
var moment = require('moment');
var request = require('request');
router.preferredBase = '/slack';

const timeForms = [ 'hh:mmA', 'hh:mm', 'hA', 'hhA', 'HH', 'H:mm', 'HH:mm' ];

/* GET users listing. */
router.get('/', function(req, res, next) {
  const db = req.app.get('db');
  db.get('users').find({}, function(err, docs) {
    if (err) {
      return next(err);
    }
    res.send(docs);
  });
});

// not-null-and-not-undefined check (I'm used to coffeescript)
function some(x) { return x != null; }

function isCommand(command) {
  return [ 'username', 'password', 'project', 'task', 'in', 'out', 'track', 'note', 'status' ].indexOf(command) !== -1;
}

function isUpdate(command) { return !(command === 'out' || command === 'track'); }

function userStatus(data) {
  if (some(data.in)) {
    var start = moment(data.in);
    data.in = util.format('%s (%s)', start.format(timeForms[0]), start.fromNow());
  }

  var out = util.format(
    'username: *%s*, password: *%s*, project: *%s*, task: *%s*, started: *%s*',
    data.username, data.password, data.project, data.task, data.in
  );

  if (some(data.note)) {
    out += util.format('\nnote: *%s*', data.note);
  }

  return out;
}

/* curl -X POST \
**   -d "login=ttt-slack-staging" \
**   -d "password=12345678" \
**   -d "project=ttt-slack" \
**   -d "task=consulting" \
**   -d "start=09:00" \
**   -d "finish=10:00" \
**   -d "date=2016-03-12" \
**   -d "note=hello" \
**   https://ttt-proxy-staging.herokuapp.com/track-time */
function mongoToAnuko(data) {
  var tmp = {};
  var now = moment(data.out);

  tmp.login    = data.username;
  tmp.password = data.password;
  tmp.project  = data.project;
  tmp.task     = data.task;
  tmp.start    = moment(data.in).format('HH:mm');
  tmp.finish   = now.format('HH:mm');
  tmp.date     = now.format('YYYY-MM-DD');

  if (some(data.note)) {
    tmp.note = data.note;
  }

  return tmp;
}

function sendf(res) {
  var args = Array.prototype.slice.call(arguments, 1);

  res.send(util.format.apply(this, args));
}

// used to identify the property that is missing
function readyForAnuko(data) {
  var missing = null;
  [ 'username', 'password', 'project', 'task', 'in' ].some(function (prop) {
    if (!some(data[prop])) {
      missing = prop;
      return true
    }
  });

  return missing;
}

router.post('/', function(req, res, next) {
  // skip/ignore POST if it doesn't have Slack's API token
  if (req.app.get('slack-token') !== req.body.token) {
    res.status(403).send('Slack imposter!');
    return;
  }

  // we need user_id for Mongo
  if (!some(req.body.user_id)) {
    res.status(400);
    res.send('Who are you? No user_id sent from Slack.');
    return;
  }

  const id    = req.body.user_id;
  const users = req.app.get('db').get('users');

  var args = req.body.text.split(/\s+/);
  var command = args.shift();

  if (some(command)) {
    command = command.toLowerCase();
  }

  if (!isCommand(command)) {
    res.status(400);
    sendf(res, 'unrecognized command: *%s*', command);
    return;
  }

  if (isUpdate(command)) {
    if (args.length === 0) {
      switch (command) {
        case 'in':
          args = [ new Date ];
          break;
        case 'status':
          // an update-anyway query
          args = [ id ];
          break;
        default:
          res.status(400);
          sendf(res, 'missing argument to *%s*', command);
          return;
      }
    }

    if (command === 'note') {
      var tmp = /\w+\s+(.*)/.exec(req.body.text);
      args = [ tmp[0] ]; // the note
    }

    var set = {};

    // because precomputed properties :(
    switch (command) {
      case 'username': set.username = args[0]; break;
      case 'password': set.password = args[0]; break;
      case 'in'      : set.in       = args[0]; break;
      case 'project' : set.project  = args[0]; break;
      case 'task'    : set.task     = args[0]; break;
      case 'note'    : set.note     = args[0]; break;
      case 'status'  : set.id       = args[0]; break;
    }

    users.findAndModify(
      { id: id }, // query
      { $set: set }, // update
      { new: true, upsert: true }, // return most-current, insert if non-existent
      function (err, data) {
        if (some(err)) {
          res.status(500);
          sendf(res, 'MongoDB error: *%s*', err);
          return;
        }

        res.status(200).send(userStatus(data));
      }
    );
    return;
  }

  // if we're here, we're trying to POST to Anuko (/ttt out & /ttt track ...)
  users.findOne(
    { id: id },
    function (err, data) {
      if (some(err)) {
        res.status(500);
        sendf(res, 'DB: *%s*', err);
        return;
      }

      if (!some(data)) {
        data = {};
      }

      if (command === 'track') {
        if (args.length < 4) {
          res.status(400).send('not enough arguments: `/ttt track &lt;project&gt; &lt;task&gt; &lt;start-time&gt; &lt;finish-time&gt; [&lt;note&gt;]`');
          return;
        }


        args[2] = moment(args[2], timeForms, true);

        if (!args[2].isValid()) {
          res.status(400);
          sendf(res, '`start-time` was in the wrong format (example: `%s`)', moment().format(timeForms[0]));
          return;
        }

        args[2] = args[2].toDate();

        args[3] = moment(args[3], timeForms, true);

        if (!args[3].isValid()) {
          res.status(400);
          sendf(res, '`finish-time` was in the wrong format (example: `%s`)', moment().format(timeForms[0]));
          return;
        }

        args[3] = args[3].toDate();


        args.splice(4); // remove the split/mangled note
        var tmp = /\w+\s+\w+\s+\w+\s+\w+\s+(.*)/.exec(req.body.text);
        if (some(tmp)) {
          args.push(tmp[1]); // the note
        }

        [ 'project', 'task', 'in', 'out', 'note' ].forEach(function (p) {
          data[p] = args.shift();
        });
      }

      var missing = readyForAnuko(data);

      if (some(missing)) {
        res.status(428);
        if (missing === 'in') {
          res.send('first do: `/ttt in`');
        }
        else {
          sendf(res, 'first do: `/ttt %s &lt;%s&gt;`', missing, missing);
        }
        return;
      }

      var uri  = req.app.get('ttt-proxy-uri');
      var form = mongoToAnuko(data);

      res.status(200);
      sendf(res, 'registering *%s* task with Amuko, try again if not successful in 5 seconds', data.task);

      request.post({ url: uri, form: form }, function (err, post, body) {
        var ack = 'unsuccessful - please try again';

        if (!some(err) && post.statusCode === 200) {
          ack = util.format('task *%s* has been recorded in Amuko! (%s) :smile:', data.task, body || err);

          // clear the task & start-time fields
          users.findAndModify({ id: id }, { $unset: { in: true, note: true } });
        }

        // even the POST back to Slack can fail - this is a one-off, hit-or-miss acknowledgement
        request.post({ url: req.body.response_url, json: true, body: { text: ack } });
      });

    }
  );
});

module.exports = router;
