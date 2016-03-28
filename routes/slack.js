var express = require('express');
var router = express.Router();
var util = require('util');
var moment = require('moment');
var request = require('request');
require('moment-timezone');

router.preferredBase = '/slack';

const IN_TZ  = process.env.LOCAL_TIMEZONE || 'Asia/Jerusalem';
const OUT_TZ = process.env.ANUKO_TIMEZONE || 'GMT';
const timeForms = [ 'hh:mmA', 'hh:mm', 'hA', 'hhA', 'HH', 'H:mm', 'HH:mm' ];

moment.tz.setDefault(IN_TZ);

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

function string_repeat(s, n) {
  return new Array(n + 1).join(s);
}

function isCommand(command) {
  return [ 'username', 'password', 'project', 'task', 'in', 'out', 'track', 'status' ].indexOf(command) !== -1;
}

function isUpdate(command) { return !(command === 'out' || command === 'track'); }

function userStatus(data) {
  if (some(data.in)) {
    var start = moment(data.in);
    data.in = util.format('%s (%s)', start.format(timeForms[0]), start.fromNow());
  }

  if (some(data.password)) {
    data.password = string_repeat('*', data.password.length);
  }

  var out = util.format(
    'username: *%s*, password: *%s*, project: *%s*, task: *%s*, started: *%s*',
    data.username, data.password, data.project, data.task, data.in
  );

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
**   https://ttt-proxy-staging.herokuapp.com/track-time */
function mongoToAnuko(data) {
  var tmp = {};

  tmp.login    = data.username;
  tmp.password = data.password;
  tmp.project  = data.project;
  tmp.task     = data.task;
  tmp.start    = moment(data.in).tz(OUT_TZ).format('HH:mm');
  tmp.finish   = moment(data.out).tz(OUT_TZ).format('HH:mm');
  tmp.date     = moment(data.date).tz(OUT_TZ).format('YYYY-MM-DD');

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

  // we want coercion here - '' -> false
  if (!command) {
    res.send('`/ttt` - shows this help text\n' +
      '`/ttt status` - shows information associated with your account\n' +
      '`/ttt username &lt;username&gt;` - sets your username for Anuko\n' +
      '`/ttt password &lt;password&gt;` - sets your password for Anuko\n' +
      '`/ttt project &lt;project&gt;` - sets the project name of your current task\n' +
      '`/ttt task &lt;task&gt;` - sets the name of your current ask\n' +
      '`/ttt in` - begins tracking your current task from the current time\n' +
      '`/ttt out` - ends tracking your current task and attempts to send task info to Anuko\n' +
      '`/ttt track &lt;project&gt; &lt;task&gt; &lt;start-time&gt; &lt;finish-time&gt; [&lt;date&gt;]` - record a task directly to Anuko\n' +
      'time example: `09:00AM`, date example: `2016-12-31`');
    return;
  }

  command = command.toLowerCase();

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

    var set = {};

    // because precomputed properties :(
    switch (command) {
      case 'username': set.username = args[0]; break;
      case 'password': set.password = args[0]; break;
      case 'in'      : set.in       = args[0]; break;
      case 'project' : set.project  = args[0]; break;
      case 'task'    : set.task     = args[0]; break;
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
          res.status(400).send('not enough arguments: `/ttt track &lt;project&gt; &lt;task&gt; &lt;start-time&gt; &lt;finish-time&gt; [&lt;date&gt;]`');
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

        if (some(args[4])) {
          // store in "Anuko-time" as we're referring to an exact date
          args[4] = moment.tz(args[4], 'YYYY-MM-DD', true, OUT_TZ);

          if (!args[4].isValid()) {
            res.status(400);
            sendf(res, 'optional `date` argument was in the wrong format (example: `%s`)', moment().format('YYYY-MM-DD'));
            return;
          }
        }

        [ 'project', 'task', 'in', 'out', 'date' ].forEach(function (p) {
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
      sendf(res, 'registering *%s* task with Amuko, try again if not successful in 10 seconds', data.task);

      request.post({ url: uri, form: form }, function (err, post, body) {
        var ack = 'unsuccessful - please try again';

        if (!some(err) && post.statusCode === 200) {
          ack = util.format('task *%s* has been recorded in Amuko! (%s) :smile:', data.task, body || err);

          // only clear the start-time on '/ttt out'
          if (command === 'out') {
            users.findAndModify({ id: id }, { $unset: { in: true } });
          }
        }

        // even the POST back to Slack can fail - this is a one-off, hit-or-miss acknowledgement
        request.post({ url: req.body.response_url, json: true, body: { text: ack } });
      });
    }
  );
});

module.exports = router;
