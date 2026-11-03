=== Code & Blocks MCP Bridge ===
Contributors: codeandblocks
Tags: mcp, ai, claude, rest-api, developer
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later

Companion plugin for the self-hosted Code & Blocks WordPress MCP server.

== Description ==

Adds admin-only REST endpoints (namespace cbmcp/v1) used by the Code & Blocks WordPress MCP server:

* Read, write, edit, search and delete files in wp-content/themes, plugins, mu-plugins and languages
* PHP syntax check before saving PHP files, JSON check for .json files
* Automatic backups (last 10 per file) in wp-content/cbmcp-backups, restorable
* PHP snippets that run on every request; failing snippets are disabled automatically
* Read/write WordPress options (core URL/theme/plugin options are protected)
* Flush object cache and common page-cache plugins
* Switch the active theme, copy a theme as inactive draft, create child themes
* Read and write post/term/user meta incl. protected keys (page builders, SEO plugins), with backups
* Read-only SQL queries and table overview (writes only with CBMCP_ALLOW_DB_WRITE)
* WP-Cron: list, run, pause and resume events
* Send a test email and report the effective sender and mail plugins
* Duplicate a page as draft (incl. builder data) and apply the reviewed copy back, with backup
* Time-limited preview links for drafts and inactive themes (no login needed)

All endpoints require the manage_options capability. Authentication happens through WordPress Application Passwords.

Optional constants in wp-config.php:

* define( 'CBMCP_DISABLE_FILE_WRITE', true ); – read-only file access
* define( 'CBMCP_DISABLE_SNIPPETS', true ); – disable snippet management
* define( 'CBMCP_SAFE_MODE', true ); – do not run any snippet (rescue mode)
* define( 'CBMCP_ALLOW_DB_WRITE', true ); – allow INSERT/UPDATE/DELETE/REPLACE through db_query

Author: Code & Blocks by Marijan
