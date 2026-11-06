=== Code & Blocks MCP Bridge ===
Contributors: codeandblocks
Tags: mcp, ai, claude, rest-api, developer
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.3.0
License: GPLv2 or later

Companion plugin for the self-hosted Code & Blocks WordPress MCP server.

== Description ==

Connects WordPress to your self-hosted Code & Blocks WordPress MCP server and adds admin-only REST endpoints (namespace cbmcp/v1):

* Admin page "Code & Blocks MCP": connect with a connection code from the operator, status, disconnect
* "Portal öffnen": sign in to the MCP server portal with your WordPress account (no extra password)
* Login with WordPress for AI clients (OAuth through the MCP server)
* Switches for file editing, snippets, database writes, safe mode and live notices
* Activity log of every change made through the MCP server, admin-bar counter and live notices (Heartbeat)
* Snippet and backup management in wp-admin
* Plugin, theme and core updates for the MCP server's update overview

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
