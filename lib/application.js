
'use strict';

/**
 * Module dependencies.
 */

const isGeneratorFunction = require('is-generator-function');
const debug = require('debug')('koa:application');
//  当 http 请求关闭,完成或出错的时候调用注册好的回调
const onFinished = require('on-finished');
const response = require('./response');
const compose = require('koa-compose');
const context = require('./context');
const request = require('./request');
const statuses = require('statuses');
const Emitter = require('events');
const util = require('util');
const Stream = require('stream');
const http = require('http');
//  白名单
const only = require('only');
//  兼容旧版本 koa 中间件,核心利用 co 库
const convert = require('koa-convert');
//  判断当前在运行 koa 的某些接口或方法是否过期,如过期会给升级提示
const deprecate = require('depd')('koa');
const { HttpError } = require('http-errors');

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */

/**
 * 继承Emitter,故Application有异步事件的处理能力
 * 
 * application.js核心其实处理了4件事情
 * 1.启动框架
 * 2.实现洋葱模型中间件机制
 * 3.封装高内聚的context
 * 4.实现异步函数的统一错误处理机制
 */
module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  /**
    *
    * @param {object} [options] Application options
    * @param {string} [options.env='development'] Environment
    * @param {string[]} [options.keys] Signed cookie keys
    * @param {boolean} [options.proxy] Trust proxy headers
    * @param {number} [options.subdomainOffset] Subdomain offset
    * @param {boolean} [options.proxyIpHeader] proxy ip header, default to X-Forwarded-For
    * @param {boolean} [options.maxIpsCount] max ips read from proxy ip header, default to 0 (means infinity)
    *
    */

  constructor(options) {
    super();
    options = options || {};
    this.proxy = options.proxy || false;  //    是否信任请求中的代理字段
    this.subdomainOffset = options.subdomainOffset || 2;  //  需要忽略的域名个数
    this.proxyIpHeader = options.proxyIpHeader || 'X-Forwarded-For';  //  请求头的代理字段
    this.maxIpsCount = options.maxIpsCount || 0;  //   代理头读取的最大ips,0代表无限
    this.env = options.env || process.env.NODE_ENV || 'development';
    if (options.keys) this.keys = options.keys;
    this.middleware = [];   //  中间件列表
    this.context = Object.create(context);  //  上下文对象,贯穿所有中间件
    this.request = Object.create(request);  //  包装的请求对象
    this.response = Object.create(response);  //  包装的响应对象
    /**
     * Object.create(xxx)作用:根据xxx创建一个新对象,并且将xxx的属性和方法作为新对象的proto
     * 例如:this.contenxtObject.create(context)其实是创建一个新对象
     * 使用context对象来提供新对象的proto,这个对象赋值给this.context,实现了类继承的作用
     * 如果直接使用this.context=context,这样会导致两者指向同一片内存,而不是继承的目的
     */

    // util.inspect.custom support for node 6+
    /* istanbul ignore else */
    if (util.inspect.custom) {
      this[util.inspect.custom] = this.inspect;
    }
  }

  /**
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * @param {Mixed} ...
   * @return {Server}
   * @api public
   */

  //  创建服务器
  listen (...args) {
    debug('listen');
    //  this..callback()是需要重点关注的部分
    //  其实对应了http.createServer的参数(req,res)=>{}
    const server = http.createServer(this.callback());
    return server.listen(...args);
  }

  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON () {
    //  koa 应用只会输出 subdomainOffset,proxy,env三条信息
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ]);
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect () {
    return this.toJSON();
  }

  /**
   * Use the given middleware `fn`.
   *
   * Old-style middleware will be converted.
   *
   * @param {Function} fn
   * @return {Application} self
   * @api public
   */

  /**
 *  通过调用koa应用实例的use函数,形如
 * koa1:
 *  app.use(function* (ctx, next) { 
 *     ctx.test = '123';
 *     yield next;
 *  });
 * 
 *  koa2:
 *  app.use(async (ctx,next)=> {
 *    await next()
 *  })
 */
  use (fn) {
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');  //  如果不是函数,则抛出错误
    //  兼容koa1,如果是生成器函数,会转换成promise函数
    if (isGeneratorFunction(fn)) {
      deprecate('Support for generators will be removed in v3. ' +
        'See the documentation for examples of how to convert old middleware ' +
        'https://github.com/koajs/koa/blob/master/docs/migration.md');
      //  兼容旧版本 koa 中间件,利用 co 库将生成器函数转换成promise函数
      fn = convert(fn);
    }
    debug('use %s', fn._name || fn.name || '-');
    //  将函数存入middleware数组
    this.middleware.push(fn);
    //  返回this,则我们后续可链式调用app.use(fn).use(fn2)   
    return this;
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

  /**
   * 可看出以下关键细节
   * 1. compose(this.middleware)做了什么事情（使用了koa-compose包）。
   * 2. 如何实现洋葱式调用的？
   * 3. context是如何处理的？createContext的作用是什么？
   * 4. koa的统一错误处理机制是如何实现的？
   */
  callback () {
    /**
     * compose 函数的实现如下，它返回一个函数，接收上下文与 next 参数
     * 内部通过递归的方式调用中间件数组中的函数，每个中间件函数接收上下文与下一个函数（next）作为参数
     * 调用 next 参数返回后，该重新获得函数的控制权。就这样实现了洋葱模型
     */

    //  1.compose处理所有中间件函数。洋葱模型实现核心
    const fn = compose(this.middleware);

    //  2.绑定错误处理函数
    if (!this.listenerCount('error')) this.on('error', this.onerror);

    const handleRequest = (req, res) => {
      //  3.基于req,res封装出更强大的ctx
      const ctx = this.createContext(req, res);
      //  4.调用app实例上的handleResult,注意区分本函数的handleResult
      return this.handleRequest(ctx, fn);
    };
    //  返回 handleRequest 给 http.createServer作为参数 即返回: (req,res)=>{}
    return handleRequest;
  }

  /**
   * Handle request in callback.
   *
   * @api private
   */

  handleRequest (ctx, fnMiddleware) {
    const res = ctx.res;
    res.statusCode = 404;
    //  调用context.js的onerror函数
    const onerror = err => ctx.onerror(err);
    //  处理响应内容
    const handleResponse = () => respond(ctx);
    //  确保一个流在关闭,完成和报错时都会执行响应的回调函数
    onFinished(res, onerror);
    //  中间件执行,统一错误处理机制的关键
    return fnMiddleware(ctx).then(handleResponse).catch(onerror);
  }

  /**
   * Initialize a new context.
   *
   * @api private
   */

  createContext (req, res) {
    /* 1、创建 request、response 对象，挂载到创建的 context 对象上
      context: {
        request: this.request, // Object.create(request)
        response: this.response, // Object.create(response)
        __proto__: Object.create(this.context) 
      } 
    */

    //  注意点:通过object.create创建新对象，使每次请求获得的ctx与request都是全新的
    const context = Object.create(this.context);
    const request = context.request = Object.create(this.request);
    const response = context.response = Object.create(this.response);

    /* 2、将 req、res、this 挂载到 context、request、response对象上
      context: {
        app: this,
        req: req,
        res: res,
        __proto__: Object.create(this.context) 
      }
      request: {
        app: this,
        req: req,
        res: res,
        __proto__: Object.create(this.request)
      }
      response: {
        app: this,
        req: req,
        res: res,
        __proto__: Object.create(this.response)
      }
    */

    //  注意点:初始化context，这里的req和res是原始的node对象
    context.app = request.app = response.app = this;
    context.req = request.req = response.req = req;
    context.res = request.res = response.res = res;
    /* 3、将 context、response挂载到 request 对象上，以此类推
        request:{
          ctx: context,
          response: response
        }
        response: {
          ctx: context,
          request: request
        }
    */
    request.ctx = response.ctx = context;
    request.response = response;

    response.request = request;
    /* 4、将 req.url 挂载到 request 对象上的 originalUrl 属性上 */
    context.originalUrl = request.originalUrl = req.url;
    context.state = {};
    return context;
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror (err) {
    // When dealing with cross-globals a normal `instanceof` check doesn't work properly.
    // See https://github.com/koajs/koa/issues/1466
    // We can probably remove it once jest fixes https://github.com/facebook/jest/issues/2549.
    const isNativeError =
      Object.prototype.toString.call(err) === '[object Error]' ||
      err instanceof Error;
    // 实例错误 抛出错误
    if (!isNativeError) throw new TypeError(util.format('non-error thrown: %j', err));

    //  404错误
    if (404 === err.status || err.expose) return;
    //  不需要监控 http 错误 (将 silentHttp 属性设为 true)
    if (this.silent) return;

    //  打印错误
    const msg = err.stack || err.toString();
    console.error(`\n${msg.replace(/^/gm, '  ')}\n`);
  }

  /**
   * Help TS users comply to CommonJS, ESM, bundler mismatch.
   * @see https://github.com/koajs/koa/issues/1513
   */

  static get default () {
    return Application;
  }
};

/**
 * Response helper.
 */

function respond (ctx) {
  // allow bypassing koa
  if (false === ctx.respond) return;

  if (!ctx.writable) return;

  const res = ctx.res;
  let body = ctx.body;
  const code = ctx.status;

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null;
    return res.end();
  }

  //  HEAD请求处理
  if ('HEAD' === ctx.method) {
    //  没有发送响应头
    if (!res.headersSent && !ctx.response.has('Content-Length')) {
      const { length } = ctx.response;
      if (Number.isInteger(length)) ctx.length = length;
    }
    return res.end();
  }

  // status body
  if (null == body) {
    if (ctx.response._explicitNullBody) {
      ctx.response.remove('Content-Type');
      ctx.response.remove('Transfer-Encoding');
      return res.end();
    }
    if (ctx.req.httpVersionMajor >= 2) {
      body = String(code);
    } else {
      body = ctx.message || String(code);
    }
    if (!res.headersSent) {
      ctx.type = 'text';
      ctx.length = Buffer.byteLength(body);
    }
    return res.end(body);
  }

  // responses
  if (Buffer.isBuffer(body)) return res.end(body);  //  Buffer
  if ('string' === typeof body) return res.end(body); //  String
  if (body instanceof Stream) return body.pipe(res);  //  Stream

  // body: json
  body = JSON.stringify(body);
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body);
  }
  res.end(body);
}

/**
 * Make HttpError available to consumers of the library so that consumers don't
 * have a direct dependency upon `http-errors`
 */

module.exports.HttpError = HttpError;
