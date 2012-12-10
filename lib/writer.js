/*
 * writer tools for nico
 *
 * @author: Hsiaoming Yang <lepture@me.com>
 */

var fs = require('fs');
var path = require('path');
var swig = require('swig');
var _ = require('underscore');
var utils = require('./utils');
var logging = utils.logging;
var Class = require('arale').Class;
var isInitSwig = false;

function initSwig(obj) {
  if (isInitSwig) return;
  obj.swigConfig = obj.swigConfig || {};
  _.extend(obj.swigConfig, obj.config.swigConfig || {});
  var swigConfig = obj.swigConfig;

  // find swig root
  if (!swigConfig.root) {
    swigConfig.root = [];
    var templates = path.join(process.cwd(), '_templates');
    if (fs.existsSync(templates)) swigConfig.root.push(templates);
    if (obj.config && obj.config.theme) {
      swigConfig.root.push(path.join(obj.config.theme, 'templates'));
    }
    if (!swigConfig.root.length) {
      logging.error('no theme is assigned.');
      process.exit(1);
    }
  }

  var key, func;
  // find swig filters
  swigConfig.filters = swigConfig.filters || {};
  for (key in swigConfig.filters) {
    func = swigConfig.filters[key];
    if (_.isString(func)) {
      func = utils.require(func);
    }
    swigConfig.filters[key] = func;
  }

  // register globals
  swigConfig.globals = swigConfig.globals || {};
  if (obj.resource) swigConfig.globals.resource = obj.resource;

  // register functions
  for (key in swigConfig.functions) {
    func = swigConfig.functions[key];
    if (_.isString(func)) {
      func = utils.require(func);
    }
    swigConfig.globals[key] = func;
  }

  swig.init({
    autoescape: false,
    cache: false,
    allowErrors: false,
    encoding: swigConfig.encoding || 'utf8',
    filters: swigConfig.filters,
    globals: swigConfig.globals,
    root: swigConfig.root,
    tzOffset: swigConfig.tzOffset || 0
  });
  isInitSwig = true;
}


var BaseWriter = Class.create({
  writerName: 'BaseWriter',

  initialize: function(storage) {
    initSwig(storage);
    this.storage = storage;
  },

  start: function() {
    if (this.setup) {
      this.setup();
    }
    logging.start('Starting %s', this.writerName);
    return this;
  },
  // render and write html to destination
  render: function(obj) {
    var filepath = utils.relativePath(
      obj.destination, this.storage.config.ouput
    );
    filepath = filepath.toLowerCase();
    obj.params = obj.params || {};
    obj.params.writer = {
      name: this.writerName,
      filepath: filepath
    };
    obj.params.config = this.storage.config;
    // swig don't support context filters
    // register context filter here
    this.registerContextFilters(obj.params);
    // swig don't support global variables
    this.registerContextFunctions(obj.params);

    var tpl = swig.compileFile(obj.template);
    var html = tpl.render(obj.params);

    if (filepath.slice(-1) === '/') {
      filepath += 'index.html';
    } else if (filepath.slice(-5) !== '.html') {
      filepath += '.html';
    }
    logging.debug('writing content to %s', filepath);

    var destination = path.join(this.storage.config.output, filepath);
    this.write(destination, html);

    // swig don't support context filter, we can only inject code here.
    if (obj.iframes && !_.isEmpty(obj.iframes)) {
      this.writeIframes(destination, obj.iframes);
    }
  },

  // write file
  write: function(destination, content) {
    destination = destination.replace(' ', '-');
    utils.safeWrite(destination);
    fs.writeFileSync(destination, content);
  },

  end: function() {
    if (this.run) {
      this.run();
    }
    logging.end('Ending %s', this.writerName);
  },

  // iframe helper
  writeIframes: function(destination, iframes) {
    var self = this;
    var tpl = swig.compileFile('iframe.html');
    var html = '';
    var dirname = path.dirname(destination);
    var writeIframe = function(item) {
      html = tpl.render(item);
      self.write(path.join(dirname, item.key) + '.html', html);
    };
    for (var key in iframes) {
      writeIframe({key: key, code: iframes[key]});
    }
  },

  registerContextFunctions: function(ctx) {
    var key, func;
    var swigConfig = this.storage.swigConfig || {};
    var contextfunctions = swigConfig.contextfunctions;
    if (!_.isEmpty(contextfunctions)) {
      for (key in contextfunctions) {
        func = contextfunctions[key];
        if (_.isString(func)) {
          func = utils.require(func);
        }
        ctx[key] = func(ctx);
      }
    }

    return ctx;
  },

  registerContextFilters: function(ctx) {
    var swigConfig = this.storage.swigConfig || {};
    var filters = swigConfig.contextfilters;
    if (!filters) return;

    var storage = {};
    for (var key in filters) {
      var func = filters[key];
      if (_.isString(func)) {
        func = utils.require(func);
      }
      storage[key] = func(ctx);
    }
    swig.config({
      filters: storage
    });
  }
});
exports.BaseWriter = BaseWriter;


exports.PostWriter = BaseWriter.extend({
  writerName: 'PostWriter',

  run: function() {
    var self = this;
    var posts = this.storage.resource.publicPosts || [];
    posts = posts.concat(this.storage.resource.secretPosts || []);
    logging.debug('generating %d posts', posts.length);

    var post;
    posts.forEach(function(item) {
      post = createPost(self.storage, item);
      self.render({
        destination: utils.destination(
          post, self.storage.config.permalink),
        params: {post: post},
        iframes: post.iframes,
        template: post.template || 'post.html'
      });
    });
    return this;
  }
});


exports.PageWriter = BaseWriter.extend({
  writerName: 'PageWriter',

  run: function() {
    var self = this;
    var pages = this.storage.resource.pages || [];
    logging.debug('generating %d pages', pages.length);

    var page;
    pages.forEach(function(item) {
      page = createPost(self.storage, item);
      self.render({
        destination: utils.destination(
          page, '{{directory}}/{{filename}}.html'),
        params: {post: page},
        iframes: page.iframes,
        template: page.template || 'page.html'
      });
    });
    return this;
  }
});


exports.ArchiveWriter = BaseWriter.extend({
  writerName: 'ArchiveWriter',

  run: function() {
    // pagination
  }
});


exports.FileWriter = BaseWriter.extend({
  writerName: 'FileWriter',

  run: function() {
    utils.copy(
      this.storage.config.source,
      this.storage.config.output,
      this.storage.resource.files
    );
  }
});


exports.StaticWriter = BaseWriter.extend({
  writerName: 'StaticWriter',

  run: function() {
    var dest = path.join(this.storage.config.output, 'static');
    var theme = this.storage.config.theme;
    if (theme) {
      utils.copy(path.join(theme, 'static'), dest);
    }
    utils.copy(path.join(process.cwd(), '_static'), dest);
  }
});


// helpers
function createPost(storage, item) {
  return new storage.config.PostRender({
    title: item.title,
    content: item.content,
    filepath: item.filepath,
    root: storage.config.source,
    parser: storage.config.parser
  });
}