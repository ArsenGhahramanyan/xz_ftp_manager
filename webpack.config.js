//@ts-check
'use strict';
const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node', mode: 'none',
  entry: './src/extension.ts',
  output: { path: path.resolve(__dirname, 'dist'), filename: 'extension.js', libraryTarget: 'commonjs2' },
  externals: { vscode: 'commonjs vscode' },
  resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.json' } }] }] },
  // ssh2 optionally requires `cpu-features` and a prebuilt native crypto addon.
  // Both are wrapped in try/catch and gracefully fall back to Node's `crypto`,
  // so silence the resolution warnings instead of shipping native binaries.
  plugins: [
    new webpack.IgnorePlugin({ resourceRegExp: /^cpu-features$/ }),
    new webpack.IgnorePlugin({ resourceRegExp: /sshcrypto\.node$/ }),
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: { level: 'log' }
};

/** @type {import('webpack').Configuration} */
const webviewConfig = {
  target: 'web', mode: 'none',
  entry: './webview/src/index.ts',
  output: { path: path.resolve(__dirname, 'dist', 'webview'), filename: 'webview.js' },
  resolve: { extensions: ['.ts', '.js', '.css'] },
  module: { rules: [
    { test: /\.ts$/, exclude: /node_modules/, use: [{ loader: 'ts-loader', options: { configFile: path.resolve(__dirname, 'webview', 'tsconfig.json') } }] },
    // Extract CSS into a static file rather than injecting <style> at runtime.
    // The latter would require `style-src 'unsafe-inline'` in the webview CSP.
    { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }
  ] },
  plugins: [
    new MiniCssExtractPlugin({ filename: 'webview.css' }),
  ],
  devtool: 'source-map'
};

module.exports = [extensionConfig, webviewConfig];
