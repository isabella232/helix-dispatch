/*
 * Copyright 2019 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const path = require('path').posix;
const openwhisk = require('./openwhisk.js');

const HELIX_STATIC_ACTION = 'helix-services/static@v1';

/**
 * An order-preserving uniqueness filter
 * @param {Array} arr an array
 * @returns a new array in the same order, with duplicates omitted
 */
const unique = (arr) => arr.reduce((retval, item) => {
  if (retval.indexOf(item) === -1) {
    retval.push(item);
  }
  return retval;
}, []);

/**
 * Default resolver that rejects statusCodes >= 400.
 * @param res action response
 * @returns {Promise<never>}
 */
function defaultResolver(res) {
  if (res && res.statusCode >= 400) {
    const { params } = res.actionOptions;
    const rp = `${params.owner}/${params.repo}/${params.ref}${params.path}`;
    const error = new Error(`[${res.actionOptions.idx}] Error invoking ${res.actionOptions.name}(${rp}): ${res.statusCode}`);
    error.statusCode = res.statusCode === 502 ? 504 : res.statusCode;
    return Promise.reject(error);
  }
  return Promise.resolve(res);
}

/**
 * Resolver used for error pages. Resolves with a 404 if the action responded with a 200.
 * @param res action response
 * @returns {Promise<any>}
 */
function errorPageResolver(res) {
  if (res && res.statusCode === 200) {
    res.statusCode = 404;
    return Promise.resolve(res);
  }
  return defaultResolver(res);
}

/**
 * Path info structure.
 *
 * @typedef {object} PathInfo
 * @property {string} path - The path of the requested resource. eg '/foo/index.info.html'.
 * @property {string} name - The name part of the resolved resource. eg 'index'.
 * @property {string} selector - The selector of the resolved resource. eg 'info'.
 * @property {string} ext - The extension of the resolved resource. eg 'html'.
 * @property {string} relPath - The relative path ot the resolved resource. eg '/foo/index'.
 */

/**
 * Standard Parameters for Pipeline and Static Invocations
 *
 * @typedef ActionOptions
 * @property {string} owner GitHub user or organization name
 * @property {string} repo Repository name
 * @property {string} ref branch or tag name, or sha of a commit
 * @property {string} [branch] the optional branch or tag name
 */

/**
 * Resolves the given url in respect to the mount point and potential fallback directory indices.
 * @param {string} urlPath - The requested path.
 * @param {string} mount - The mount path of a strain.
 * @param {string[]} indices - array of indices.
 * @returns {PathInfo[]} An array of path info structures.
 */
function getPathInfos(urlPath, mount, indices) {
  // eslint-disable-next-line no-param-reassign
  urlPath = urlPath.replace(/\/+/, '/');
  // check if url has extension, and if not create array of directory indices.
  const urls = [];
  if (urlPath.lastIndexOf('.') <= urlPath.lastIndexOf('/')) {
    // ends with '/', get the directory index
    if (!urlPath || urlPath.endsWith('/')) {
      indices.forEach((index) => {
        const indexPath = path.resolve(urlPath || '/', index);
        urls.push(indexPath);
      });
    } else {
      // allow extension-less requests, i.e. /foo becomes /foo.html
      urls.push(`${path.resolve(urlPath)}.html`);
    }
  } else {
    urls.push(urlPath);
  }

  // calculate the path infos for each url
  return unique(urls).map((url) => {
    const lastSlash = url.lastIndexOf('/');
    const lastDot = url.lastIndexOf('.');
    if (lastDot <= lastSlash) {
      // this should not happen, as the directory index should always have an extension.
      throw new Error('directory index must have an extension.', url);
    }
    const ext = url.substring(lastDot + 1);
    let name = url.substring(lastSlash + 1, lastDot);
    let relPath = url.substring(0, lastDot);

    // check for selector
    let selector = '';
    const selDot = relPath.lastIndexOf('.');
    if (selDot > lastSlash) {
      name = url.substring(lastSlash + 1, selDot);
      selector = relPath.substring(selDot + 1);
      relPath = relPath.substring(0, selDot);
    }

    // remove mount root if needed
    let pth = url;
    if (mount && mount !== '/') {
      // strain selection should only select strains that match the url. but better check again
      if (`${relPath}/`.startsWith(`${mount}/`)) {
        relPath = relPath.substring(mount.length);
        pth = url.substring(mount.length);
      }
    }

    return {
      path: pth,
      name,
      selector,
      ext,
      relPath,
    };
  });
}

/**
 * Gets the tasks to fetch the 404 files, one from the content repo, one
 * from the fallback repo
 * @param {PathInfo[]} infos the paths to fetch from
 * @param {Promise<ActionOptions>} contentPromise coordinates for the content repo
 * @param {Promise<ActionOptions>} staticPromise coordinates for the fallback repo
 * @param {number} idxOffset helper variable for logging
 * @returns {object[]} list of actions that should get invoked
 */
function fetch404tasks(infos, wskOpts, contentPromise, staticPromise, idxOffset) {
  const attempts = [];
  if (infos[0].ext === 'html') {
    // then get the 404.html from the content repo, but only for html requests
    attempts.push(contentPromise.then((contentOpts) => ({
      resolve: errorPageResolver,
      name: HELIX_STATIC_ACTION,
      blocking: true,
      idxOffset,
      params: {
        path: '/404.html',
        esi: false,
        plain: true,
        ...wskOpts,
        ...contentOpts,
      },
    })));
    // if all fails, get the 404.html from the static repo
    attempts.push(staticPromise.then((staticOpts) => contentPromise.then(() => ({
      resolve: errorPageResolver,
      name: HELIX_STATIC_ACTION,
      blocking: true,
      idxOffset,
      params: {
        path: '/404.html',
        esi: false,
        plain: true,
        ...wskOpts,
        ...staticOpts,
      },
    }))));
  }
  return attempts;
}
/**
 * Gets the tasks to fetch raw content from the fallback repo
 * @param {PathInfo[]} infos the paths to fetch from
 * @param {object} wskOpts additional options for the OpenWhisk invocation
 * @param {Promise<ActionOptions>} contentPromise coordinates for the content repo
 * @param {Promise<ActionOptions>} staticPromise coordinates for the fallback repo
 * @returns {object[]} list of actions that should get invoked
 */
function fetchfallbacktasks(infos, wskOpts, contentPromise, staticPromise) {
  return infos.map((info) => staticPromise
    .then((staticOpts) => contentPromise
      .then(() => ({
        resolve: defaultResolver,
        name: HELIX_STATIC_ACTION,
        blocking: true,
        params: {
          path: info.path,
          esi: false,
          plain: true,
          ...wskOpts,
          ...staticOpts,
        },
      }))));
}
/**
 * Gets the tasks to invoke the pipeline action
 * @param {PathInfo[]} infos the paths to fetch from
 * @param {object} wskOpts additional options for the OpenWhisk invocation
 * @param {Promise<ActionOptions>} contentPromise coordinates for the content repo
 * @returns {object[]} list of actions that should get invoked
 */
function fetchactiontasks(infos, wskOpts, contentPromise, params) {
  return infos.map((info) => contentPromise.then((contentOpts) => {
    const actionname = `${contentOpts.package || 'default'}/${info.selector ? `${info.selector}_` : ''}${info.ext}`;
    return {
      resolve: defaultResolver,
      name: actionname,
      blocking: true,
      params: {
        path: `${info.relPath}.md`,
        rootPath: params.rootPath || '',
        ...wskOpts,
        ...contentOpts,
      },
    };
  }));
}
/**
 * Gets the tasks to fetch raw content from the content repo
 * @param {PathInfo[]} infos the paths to fetch from
 * @param {*} params - the openwhisk action params
 * @param {Promise<ActionOptions>} contentPromise coordinates for the content repo
 * @returns {object[]} list of actions that should get invoked
 */
function fetchrawtasks(infos, params, contentPromise, wskOpts) {
  return infos.map((info) => contentPromise.then((contentOpts) => ({
    resolve: defaultResolver,
    name: HELIX_STATIC_ACTION,
    blocking: true,
    params: {
      path: info.path,
      esi: false,
      plain: true,
      root: params['content.root'],
      ...wskOpts,
      ...contentOpts,
    },
  })));
}

/**
 * Resolves the branch or tag name into a sha.
 * @param {ActionOptions} opts action options
 * @returns {Promise<*>} returns a promise of the resolved ref.
 * options, with a sha instead of a branch name
 */
async function resolveRef(opts, wskOpts, log) {
  const { ref } = opts;
  if (ref && ref.match(/^[a-f0-9]{40}$/i)) {
    return { ref };
  }
  try {
    const ow = openwhisk();
    const res = await ow.actions.invoke({
      name: 'helix-services/resolve-git-ref@v1_link',
      blocking: true,
      result: true,
      params: {
        ...opts,
        ...wskOpts,
      },
    });
    if (res.body && res.body.sha) {
      return {
        // use the resolved ref
        ref: res.body.sha,
        branch: ref,
      };
    }
    let level = 'info';
    if (!res.statusCode || res.statusCode >= 500) {
      level = 'error';
    }
    log[level](`Unable to resolve ref ${ref}: ${res.statusCode} ${res.body}`);
  } catch (e) {
    log.error(`Unable to resolve ref ${ref}: ${e}`);
  }
  return { ref };
}

/**
 * updates the options with the result of the resolver promise.
 * @param {ActionOptions} opts action options
 * @param {Promise<*>} resolverPromise The promise of the resolver.
 * @returns {Promise<ActionOptions>} returns a promise of the resolve action options
 */
function updateOpts(opts, resolverPromise) {
  return resolverPromise.then((ref) => ({ ...opts, ...ref }));
}

/**
 * Checks if the options have same repository coordinates
 * @param {ActionOptions} o1 - first options
 * @param {ActionOptions} o2 - second options
 * @returns {boolean} {@code true} if the two options have same repository coordinates.
 */
function equalRepository(o1, o2) {
  return (o1.owner === o2.owner
    && o1.repo === o2.repo
    && o1.ref === o2.ref);
}

/**
 * Extracts the Github token from the action params. The Github token can be provided either
 * via `GITHUB_TOKEN` action parameter or via `x-github-token` header.
 * @param {object} params - action params
 * @returns {string} the Github token extracted from `params` or `undefined` if none was found
 */
/* istanbul ignore next */
function extractGithubToken(params = {}) {
  // eslint-disable-next-line dot-notation
  return params.GITHUB_TOKEN || (params['__ow_headers'] && params['__ow_headers']['x-github-token']);
}

/**
 * Returns the action options to fetch the contents from.
 * @param {object} params - action params
 * @returns {Array} Array of action options to use to ow.action.invoke
 */
function fetchers(params = {}) {
  const { __ow_logger: log } = params;
  const dirindex = (params['content.index'] || 'index.html').split(',');
  const infos = getPathInfos(params.path || '/', params.rootPath || '', dirindex);
  const actioninfos = getPathInfos(params.path || '/', params.rootPath || '', dirindex);
  const githubToken = extractGithubToken(params);

  const staticOpts = {
    owner: params['static.owner'],
    repo: params['static.repo'],
    ref: params['static.ref'],
    esi: params['static.esi'],
    root: params['static.root'],
  };

  const contentOpts = {
    owner: params['content.owner'],
    repo: params['content.repo'],
    ref: params['content.ref'],
    package: params['content.package'],
    params: params.params,
  };

  if (githubToken) {
    staticOpts.GITHUB_TOKEN = githubToken;
    contentOpts.GITHUB_TOKEN = githubToken;
  }

  const wskOpts = {
    // eslint-disable-next-line no-underscore-dangle
    __ow_headers: params.__ow_headers,
    // eslint-disable-next-line no-underscore-dangle
    __ow_method: params.__ow_method,
  };

  const staticResolver = resolveRef(staticOpts, wskOpts, log);
  const contentResolver = equalRepository(staticOpts, contentOpts)
    ? staticResolver
    : resolveRef(contentOpts, wskOpts, log);

  const staticPromise = updateOpts(staticOpts, staticResolver);
  const contentPromise = updateOpts(contentOpts, contentResolver);

  const baseTasks = [
    // try to get the raw content from the content repo
    ...fetchrawtasks(infos, params, contentPromise, wskOpts),
    // then, try to call the action
    ...fetchactiontasks(actioninfos, wskOpts, contentPromise, params),
    // try to get the raw content from the static repo
    ...fetchfallbacktasks(infos, wskOpts, contentPromise, staticPromise),
  ];
  return {
    base: baseTasks,
    fetch404: fetch404tasks(infos, wskOpts, contentPromise, staticPromise, baseTasks.length),
  };
}

module.exports = {
  fetchers,
  defaultResolver,
  errorPageResolver,
  getPathInfos,
};
