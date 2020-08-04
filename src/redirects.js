/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

async function redirect(params, ow) {
  const opts = {
    name: 'helix-services/redirect@v1',
    params,
  };
  console.log(opts);
  const result = await ow.actions.invoke(opts);
  console.log(result);

  return {
    type: 'none',
    target: null,
    result,
  };
}

async function sendRedirect(redirectPromise) {
  return (await redirectPromise).result;
}

async function abortRedirect(redirectPromise) {
  return {
    statusCode: 508, // loop detected, from webdav
    body: `Too many internal redirects to ${
      ((await redirectPromise).target || '').replace(/&/g, '&amp;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;')}`,
  };
}

module.exports = {
  redirect, sendRedirect, abortRedirect,
};
