<?php
/**
 * Plugin Name:       Code & Blocks MCP Bridge
 * Plugin URI:        https://github.com/
 * Description:       Gesicherte REST-Endpunkte für den Code & Blocks WordPress MCP-Server: Theme-/Plugin-Dateien, PHP-Snippets, Optionen, Cache leeren und Theme wechseln. Nur für Administratoren (Application Passwords).
 * Version:           1.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Code & Blocks by Marijan
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       cb-mcp-bridge
 *
 * Optional constants for wp-config.php:
 *   define( 'CBMCP_DISABLE_FILE_WRITE', true ); // read-only file access
 *   define( 'CBMCP_DISABLE_SNIPPETS', true );   // no snippet management
 *   define( 'CBMCP_SAFE_MODE', true );          // do not execute any snippet (rescue)
 *   define( 'CBMCP_ALLOW_DB_WRITE', true );     // allow INSERT/UPDATE/DELETE/REPLACE via db_query
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CBMCP_VERSION', '1.1.0' );
define( 'CBMCP_FILE', __FILE__ );

final class CBMCP_Bridge {

	const NS             = 'cbmcp/v1';
	const SNIPPET_OPTION = 'cbmcp_snippets';
	const MAX_READ       = 3145728; // 3 MB
	const KEEP_BACKUPS   = 10;

	/** Options that must not be changed through manage_option. */
	const PROTECTED_OPTIONS = array( 'siteurl', 'home', 'active_plugins', 'template', 'stylesheet', 'cbmcp_snippets', 'db_version', 'initial_db', 'wp_user_roles' );

	/** @var string|null */
	private static $running_snippet = null;

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'plugins_loaded', array( __CLASS__, 'run_snippets' ), 1 );
		add_action( 'plugins_loaded', array( __CLASS__, 'maybe_preview' ), 0 );
	}

	// ------------------------------------------------------------------
	// Routes
	// ------------------------------------------------------------------

	public static function register_routes() {
		$perm = array( __CLASS__, 'can_manage' );
		$r    = function ( $route, $methods, $cb ) use ( $perm ) {
			register_rest_route(
				self::NS,
				$route,
				array(
					'methods'             => $methods,
					'callback'            => array( __CLASS__, $cb ),
					'permission_callback' => $perm,
				)
			);
		};

		$r( '/info', 'GET', 'route_info' );

		$r( '/files/list', 'GET', 'route_files_list' );
		$r( '/files/read', 'GET', 'route_files_read' );
		$r( '/files/search', 'GET', 'route_files_search' );
		$r( '/files/backups', 'GET', 'route_files_backups' );
		$r( '/files/write', 'POST', 'route_files_write' );
		$r( '/files/delete', 'POST', 'route_files_delete' );
		$r( '/files/restore', 'POST', 'route_files_restore' );

		$r( '/snippets', 'GET', 'route_snippets_list' );
		$r( '/snippets/get', 'GET', 'route_snippets_get' );
		$r( '/snippets/save', 'POST', 'route_snippets_save' );
		$r( '/snippets/toggle', 'POST', 'route_snippets_toggle' );
		$r( '/snippets/delete', 'POST', 'route_snippets_delete' );

		$r( '/options/get', 'POST', 'route_option_get' );
		$r( '/options/set', 'POST', 'route_option_set' );
		$r( '/options/delete', 'POST', 'route_option_delete' );

		$r( '/cache/flush', 'POST', 'route_cache_flush' );
		$r( '/theme/activate', 'POST', 'route_theme_activate' );
		$r( '/theme/copy', 'POST', 'route_theme_copy' );
		$r( '/theme/child', 'POST', 'route_theme_child' );

		$r( '/meta/get', 'POST', 'route_meta_get' );
		$r( '/meta/set', 'POST', 'route_meta_set' );
		$r( '/meta/delete', 'POST', 'route_meta_delete' );
		$r( '/meta/backups', 'POST', 'route_meta_backups' );
		$r( '/meta/restore', 'POST', 'route_meta_restore' );

		$r( '/db/schema', 'GET', 'route_db_schema' );
		$r( '/db/query', 'POST', 'route_db_query' );

		$r( '/cron/list', 'GET', 'route_cron_list' );
		$r( '/cron/run', 'POST', 'route_cron_run' );
		$r( '/cron/pause', 'POST', 'route_cron_pause' );
		$r( '/cron/resume', 'POST', 'route_cron_resume' );

		$r( '/mail/test', 'POST', 'route_mail_test' );

		$r( '/posts/duplicate', 'POST', 'route_posts_duplicate' );
		$r( '/posts/apply', 'POST', 'route_posts_apply' );
		$r( '/preview/create', 'POST', 'route_preview_create' );
	}

	public static function can_manage() {
		if ( is_multisite() ) {
			return current_user_can( 'manage_network_options' ) || current_user_can( 'manage_options' );
		}
		return current_user_can( 'manage_options' );
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	private static function err( $code, $message, $status = 400 ) {
		return new WP_Error( $code, $message, array( 'status' => $status ) );
	}

	private static function content_dir() {
		$real = realpath( WP_CONTENT_DIR );
		return wp_normalize_path( untrailingslashit( $real ? $real : WP_CONTENT_DIR ) );
	}

	private static function allowed_roots() {
		return (array) apply_filters( 'cbmcp_allowed_roots', array( 'themes', 'plugins', 'mu-plugins', 'languages' ) );
	}

	private static function file_write_enabled() {
		return ! ( defined( 'CBMCP_DISABLE_FILE_WRITE' ) && CBMCP_DISABLE_FILE_WRITE );
	}

	private static function snippets_enabled() {
		return ! ( defined( 'CBMCP_DISABLE_SNIPPETS' ) && CBMCP_DISABLE_SNIPPETS );
	}

	private static function is_within( $path, $dir ) {
		$path = wp_normalize_path( $path );
		$dir  = untrailingslashit( wp_normalize_path( $dir ) );
		return $path === $dir || 0 === strpos( $path, $dir . '/' );
	}

	/**
	 * Resolve a wp-content relative path safely.
	 *
	 * @return array|WP_Error [ 'abs' => absolute path, 'rel' => normalized relative path, 'root' => root dir ]
	 */
	private static function resolve( $rel, $must_exist = true ) {
		$rel = wp_normalize_path( (string) $rel );
		$rel = trim( $rel, '/' );
		if ( '' === $rel || false !== strpos( $rel, "\0" ) ) {
			return self::err( 'cbmcp_bad_path', 'Invalid path.' );
		}
		$parts = explode( '/', $rel );
		foreach ( $parts as $seg ) {
			if ( '' === $seg || '.' === $seg || '..' === $seg ) {
				return self::err( 'cbmcp_bad_path', 'Path must not contain empty, "." or ".." segments.' );
			}
		}
		$root = $parts[0];
		if ( ! in_array( $root, self::allowed_roots(), true ) ) {
			return self::err( 'cbmcp_forbidden_root', 'Path must start with one of: ' . implode( ', ', self::allowed_roots() ), 403 );
		}

		$base      = self::content_dir();
		$root_real = realpath( $base . '/' . $root );
		if ( false === $root_real ) {
			return self::err( 'cbmcp_not_found', "wp-content/$root does not exist.", 404 );
		}
		$root_real = wp_normalize_path( $root_real );
		$abs       = $base . '/' . $rel;

		if ( file_exists( $abs ) ) {
			$real = wp_normalize_path( realpath( $abs ) );
			if ( ! self::is_within( $real, $root_real ) ) {
				return self::err( 'cbmcp_forbidden', 'Path resolves outside the allowed folder.', 403 );
			}
			return array( 'abs' => $real, 'rel' => $rel, 'root' => $root_real );
		}
		if ( $must_exist ) {
			return self::err( 'cbmcp_not_found', "File not found: $rel", 404 );
		}

		// New file: validate the nearest existing ancestor.
		$ancestor = dirname( $abs );
		while ( ! file_exists( $ancestor ) && strlen( $ancestor ) > strlen( $base ) ) {
			$ancestor = dirname( $ancestor );
		}
		$anc_real = realpath( $ancestor );
		if ( false === $anc_real || ! self::is_within( wp_normalize_path( $anc_real ), $root_real ) ) {
			return self::err( 'cbmcp_forbidden', 'Path resolves outside the allowed folder.', 403 );
		}
		$rest = substr( wp_normalize_path( $abs ), strlen( wp_normalize_path( $ancestor ) ) );
		return array( 'abs' => wp_normalize_path( $anc_real ) . $rest, 'rel' => $rel, 'root' => $root_real );
	}

	/** Never let the bridge modify itself (would lock the user out). */
	private static function is_self( $abs ) {
		return self::is_within( $abs, wp_normalize_path( dirname( realpath( CBMCP_FILE ) ) ) );
	}

	private static function lint_php( $code ) {
		if ( ! function_exists( 'token_get_all' ) || ! defined( 'TOKEN_PARSE' ) ) {
			return true; // tokenizer not available – cannot check
		}
		try {
			token_get_all( $code, TOKEN_PARSE );
		} catch ( \ParseError $e ) {
			return self::err( 'cbmcp_php_syntax', sprintf( 'PHP syntax error on line %d: %s', $e->getLine(), $e->getMessage() ), 422 );
		}
		return true;
	}

	private static function protected_dir( $name ) {
		$dir = self::content_dir() . '/' . $name;
		if ( ! is_dir( $dir ) ) {
			wp_mkdir_p( $dir );
		}
		if ( ! file_exists( $dir . '/index.php' ) ) {
			@file_put_contents( $dir . '/index.php', "<?php\n// Silence is golden.\n" ); // phpcs:ignore
		}
		if ( ! file_exists( $dir . '/.htaccess' ) ) {
			@file_put_contents( $dir . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n" ); // phpcs:ignore
		}
		return $dir;
	}

	/** Sortable timestamp with microseconds, so "latest" is correct even within one second. */
	private static function backup_stamp() {
		$t = microtime( true );
		return gmdate( 'Ymd-His', (int) $t ) . '-' . sprintf( '%06d', (int) ( ( $t - floor( $t ) ) * 1000000 ) );
	}

	private static function backup_prefix( $rel ) {
		return str_replace( '/', '__', $rel ) . '.';
	}

	private static function list_backups( $rel ) {
		$dir    = self::protected_dir( 'cbmcp-backups' );
		$prefix = self::backup_prefix( $rel );
		$out    = array();
		foreach ( (array) scandir( $dir ) as $f ) {
			if ( 0 === strpos( $f, $prefix ) && '.bak' === substr( $f, -4 ) ) {
				$out[] = $f;
			}
		}
		rsort( $out ); // timestamped names → newest first
		return $out;
	}

	private static function backup( $abs, $rel ) {
		if ( ! is_file( $abs ) ) {
			return null;
		}
		$dir  = self::protected_dir( 'cbmcp-backups' );
		$name = self::backup_prefix( $rel ) . self::backup_stamp() . '.bak';
		if ( ! @copy( $abs, $dir . '/' . $name ) ) { // phpcs:ignore
			return null;
		}
		$all = self::list_backups( $rel );
		foreach ( array_slice( $all, self::KEEP_BACKUPS ) as $old ) {
			@unlink( $dir . '/' . $old ); // phpcs:ignore
		}
		return $name;
	}

	private static function after_write( $abs ) {
		if ( function_exists( 'opcache_invalidate' ) && '.php' === strtolower( substr( $abs, -4 ) ) ) {
			@opcache_invalidate( $abs, true ); // phpcs:ignore
		}
		clearstatcache( true, $abs );
	}

	// ------------------------------------------------------------------
	// Info
	// ------------------------------------------------------------------

	public static function route_info() {
		global $wp_version;
		$theme = wp_get_theme();
		return array(
			'bridge_version'   => CBMCP_VERSION,
			'wp_version'       => $wp_version,
			'php_version'      => PHP_VERSION,
			'multisite'        => is_multisite(),
			'theme'            => array(
				'name'           => $theme->get( 'Name' ),
				'stylesheet'     => $theme->get_stylesheet(),
				'template'       => $theme->get_template(),
				'version'        => $theme->get( 'Version' ),
				'is_block_theme' => function_exists( 'wp_is_block_theme' ) ? wp_is_block_theme() : false,
				'is_child_theme' => is_child_theme(),
			),
			'file_roots'       => self::allowed_roots(),
			'file_write'       => self::file_write_enabled(),
			'snippets'         => self::snippets_enabled(),
			'safe_mode'        => defined( 'CBMCP_SAFE_MODE' ) && CBMCP_SAFE_MODE,
			'tokenizer_lint'   => function_exists( 'token_get_all' ),
			'wp_debug'         => defined( 'WP_DEBUG' ) && WP_DEBUG,
			'memory_limit'     => ini_get( 'memory_limit' ),
			'object_cache'     => wp_using_ext_object_cache(),
			'permalinks'       => get_option( 'permalink_structure' ),
			'db_write'         => self::db_write_enabled(),
			'db_prefix'        => $GLOBALS['wpdb']->prefix,
			'active_plugins'   => (array) get_option( 'active_plugins', array() ),
		);
	}

	// ------------------------------------------------------------------
	// Files
	// ------------------------------------------------------------------

	public static function route_files_list( WP_REST_Request $req ) {
		$p = self::resolve( $req->get_param( 'path' ) ? $req->get_param( 'path' ) : 'themes' );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		if ( ! is_dir( $p['abs'] ) ) {
			return self::err( 'cbmcp_not_dir', 'Not a directory.' );
		}
		$depth = max( 1, min( 6, (int) ( $req->get_param( 'depth' ) ? $req->get_param( 'depth' ) : 2 ) ) );
		$skip  = array( '.git', 'node_modules', 'vendor', '.svn', '.idea' );
		$out   = array();
		$limit = 1500;

		$walk = function ( $dir, $rel, $level ) use ( &$walk, &$out, $depth, $skip, $limit ) {
			$entries = @scandir( $dir ); // phpcs:ignore
			if ( false === $entries ) {
				return;
			}
			foreach ( $entries as $e ) {
				if ( '.' === $e || '..' === $e ) {
					continue;
				}
				if ( count( $out ) >= $limit ) {
					return;
				}
				$abs    = $dir . '/' . $e;
				$is_dir = is_dir( $abs );
				$item   = array(
					'path' => $rel . '/' . $e,
					'type' => $is_dir ? 'dir' : 'file',
				);
				if ( ! $is_dir ) {
					$item['size'] = @filesize( $abs ); // phpcs:ignore
				}
				if ( $is_dir && is_link( $abs ) ) {
					$item['symlink'] = true; // not followed
				}
				$out[] = $item;
				if ( $is_dir && ! is_link( $abs ) && $level < $depth && ! in_array( $e, $skip, true ) ) {
					$walk( $abs, $rel . '/' . $e, $level + 1 );
				}
			}
		};
		$walk( $p['abs'], $p['rel'], 1 );

		return array(
			'path'      => $p['rel'],
			'depth'     => $depth,
			'count'     => count( $out ),
			'truncated' => count( $out ) >= $limit,
			'entries'   => $out,
		);
	}

	public static function route_files_read( WP_REST_Request $req ) {
		$p = self::resolve( $req->get_param( 'path' ) );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		if ( ! is_file( $p['abs'] ) ) {
			return self::err( 'cbmcp_not_file', 'Not a file.' );
		}
		$size = filesize( $p['abs'] );
		if ( $size > self::MAX_READ ) {
			return self::err( 'cbmcp_too_large', "File is too large to read ($size bytes)." );
		}
		$content = file_get_contents( $p['abs'] ); // phpcs:ignore
		if ( false === $content ) {
			return self::err( 'cbmcp_read_failed', 'Could not read file.', 500 );
		}
		if ( false !== strpos( substr( $content, 0, 8000 ), "\0" ) ) {
			return self::err( 'cbmcp_binary', 'Binary file – not readable as text.' );
		}
		return array(
			'path'     => $p['rel'],
			'size'     => $size,
			'modified' => gmdate( 'c', filemtime( $p['abs'] ) ),
			'content'  => $content,
		);
	}

	public static function route_files_write( WP_REST_Request $req ) {
		if ( ! self::file_write_enabled() ) {
			return self::err( 'cbmcp_write_disabled', 'File writing is disabled (CBMCP_DISABLE_FILE_WRITE).', 403 );
		}
		$p = self::resolve( $req->get_param( 'path' ), false );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		if ( self::is_self( $p['abs'] ) ) {
			return self::err( 'cbmcp_self', 'The bridge plugin cannot modify itself.', 403 );
		}
		if ( is_dir( $p['abs'] ) ) {
			return self::err( 'cbmcp_is_dir', 'Path is a directory.' );
		}
		$content = (string) $req->get_param( 'content' );

		if ( preg_match( '/\.(php|phtml|inc)$/i', $p['abs'] ) ) {
			$lint = self::lint_php( $content );
			if ( is_wp_error( $lint ) ) {
				return $lint;
			}
		}
		if ( preg_match( '/\.json$/i', $p['abs'] ) && '' !== trim( $content ) ) {
			json_decode( $content );
			if ( JSON_ERROR_NONE !== json_last_error() ) {
				return self::err( 'cbmcp_json_syntax', 'Invalid JSON: ' . json_last_error_msg(), 422 );
			}
		}

		$dir = dirname( $p['abs'] );
		if ( ! is_dir( $dir ) ) {
			$create = $req->get_param( 'create_dirs' );
			if ( false === $create || 'false' === $create || '0' === $create ) {
				return self::err( 'cbmcp_no_dir', 'Directory does not exist.' );
			}
			if ( ! wp_mkdir_p( $dir ) ) {
				return self::err( 'cbmcp_mkdir_failed', 'Could not create directory.', 500 );
			}
		}

		$existed = is_file( $p['abs'] );
		$backup  = self::backup( $p['abs'], $p['rel'] );
		$bytes   = @file_put_contents( $p['abs'], $content, LOCK_EX ); // phpcs:ignore
		if ( false === $bytes ) {
			return self::err( 'cbmcp_write_failed', 'Could not write file (check file permissions).', 500 );
		}
		self::after_write( $p['abs'] );

		return array(
			'path'    => $p['rel'],
			'bytes'   => $bytes,
			'created' => ! $existed,
			'backup'  => $backup,
		);
	}

	public static function route_files_delete( WP_REST_Request $req ) {
		if ( ! self::file_write_enabled() ) {
			return self::err( 'cbmcp_write_disabled', 'File writing is disabled (CBMCP_DISABLE_FILE_WRITE).', 403 );
		}
		$p = self::resolve( $req->get_param( 'path' ) );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		if ( self::is_self( $p['abs'] ) ) {
			return self::err( 'cbmcp_self', 'The bridge plugin cannot modify itself.', 403 );
		}
		if ( ! is_file( $p['abs'] ) ) {
			return self::err( 'cbmcp_not_file', 'Only files can be deleted.' );
		}
		$backup = self::backup( $p['abs'], $p['rel'] );
		if ( ! @unlink( $p['abs'] ) ) { // phpcs:ignore
			return self::err( 'cbmcp_delete_failed', 'Could not delete file.', 500 );
		}
		self::after_write( $p['abs'] );
		return array(
			'deleted' => $p['rel'],
			'backup'  => $backup,
		);
	}

	public static function route_files_backups( WP_REST_Request $req ) {
		$rel = trim( wp_normalize_path( (string) $req->get_param( 'path' ) ), '/' );
		$p   = self::resolve( $rel, false );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		return array(
			'path'    => $p['rel'],
			'backups' => self::list_backups( $p['rel'] ),
		);
	}

	public static function route_files_restore( WP_REST_Request $req ) {
		if ( ! self::file_write_enabled() ) {
			return self::err( 'cbmcp_write_disabled', 'File writing is disabled (CBMCP_DISABLE_FILE_WRITE).', 403 );
		}
		$p = self::resolve( $req->get_param( 'path' ), false );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		if ( self::is_self( $p['abs'] ) ) {
			return self::err( 'cbmcp_self', 'The bridge plugin cannot modify itself.', 403 );
		}
		$all = self::list_backups( $p['rel'] );
		if ( empty( $all ) ) {
			return self::err( 'cbmcp_no_backup', 'No backup found for this file.', 404 );
		}
		$name = $req->get_param( 'backup' ) ? basename( (string) $req->get_param( 'backup' ) ) : $all[0];
		if ( ! in_array( $name, $all, true ) ) {
			return self::err( 'cbmcp_no_backup', 'Unknown backup name.', 404 );
		}
		$src = self::protected_dir( 'cbmcp-backups' ) . '/' . $name;
		if ( ! is_dir( dirname( $p['abs'] ) ) ) {
			wp_mkdir_p( dirname( $p['abs'] ) );
		}
		$current = self::backup( $p['abs'], $p['rel'] );
		if ( ! @copy( $src, $p['abs'] ) ) { // phpcs:ignore
			return self::err( 'cbmcp_restore_failed', 'Could not restore file.', 500 );
		}
		self::after_write( $p['abs'] );
		return array(
			'restored'            => $p['rel'],
			'from'                => $name,
			'backup_of_replaced'  => $current,
		);
	}

	public static function route_files_search( WP_REST_Request $req ) {
		$p = self::resolve( $req->get_param( 'path' ) ? $req->get_param( 'path' ) : 'themes' );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		$query = (string) $req->get_param( 'query' );
		if ( strlen( $query ) < 2 ) {
			return self::err( 'cbmcp_short_query', 'Query must have at least 2 characters.' );
		}
		$is_regex = (bool) $req->get_param( 'regex' );
		$case     = (bool) $req->get_param( 'case_sensitive' );
		$max      = max( 1, min( 500, (int) ( $req->get_param( 'max' ) ? $req->get_param( 'max' ) : 100 ) ) );
		$exts     = $req->get_param( 'extensions' );
		$exts     = $exts ? array_filter( array_map( 'strtolower', array_map( 'trim', is_array( $exts ) ? $exts : explode( ',', $exts ) ) ) ) : array();
		$exts     = array_map(
			function ( $e ) {
				return ltrim( $e, '.' );
			},
			$exts
		);

		if ( $is_regex ) {
			$pattern = '~' . str_replace( '~', '\~', $query ) . '~' . ( $case ? '' : 'i' ) . 'u';
			if ( false === @preg_match( $pattern, '' ) ) { // phpcs:ignore
				return self::err( 'cbmcp_bad_regex', 'Invalid regular expression.' );
			}
		}

		$results = array();
		$files   = 0;
		$skip    = array( '.git', 'node_modules', 'vendor', '.svn' );
		$iter    = new RecursiveIteratorIterator(
			new RecursiveCallbackFilterIterator(
				new RecursiveDirectoryIterator( $p['abs'], FilesystemIterator::SKIP_DOTS ),
				function ( $current ) use ( $skip ) {
					return ! ( $current->isDir() && in_array( $current->getFilename(), $skip, true ) );
				}
			)
		);

		foreach ( $iter as $file ) {
			if ( ! $file->isFile() || $file->getSize() > 1048576 ) {
				continue;
			}
			if ( $exts && ! in_array( strtolower( $file->getExtension() ), $exts, true ) ) {
				continue;
			}
			if ( ++$files > 20000 ) {
				break;
			}
			$fh = @fopen( $file->getPathname(), 'r' ); // phpcs:ignore
			if ( ! $fh ) {
				continue;
			}
			$line_no = 0;
			while ( false !== ( $line = fgets( $fh ) ) ) {
				$line_no++;
				if ( 1 === $line_no && false !== strpos( $line, "\0" ) ) {
					break; // binary
				}
				$hit = $is_regex ? preg_match( $pattern, $line ) : ( $case ? false !== strpos( $line, $query ) : false !== stripos( $line, $query ) );
				if ( $hit ) {
					$rel       = $p['rel'] . substr( wp_normalize_path( $file->getPathname() ), strlen( $p['abs'] ) );
					$results[] = array(
						'path' => $rel,
						'line' => $line_no,
						'text' => mb_substr( rtrim( $line ), 0, 240 ),
					);
					if ( count( $results ) >= $max ) {
						fclose( $fh ); // phpcs:ignore
						break 2;
					}
				}
			}
			fclose( $fh ); // phpcs:ignore
		}

		return array(
			'query'         => $query,
			'path'          => $p['rel'],
			'files_scanned' => $files,
			'count'         => count( $results ),
			'truncated'     => count( $results ) >= $max,
			'results'       => $results,
		);
	}

	// ------------------------------------------------------------------
	// Snippets
	// ------------------------------------------------------------------

	const SNIPPET_GUARD = "<?php\nif ( ! defined( 'ABSPATH' ) ) { exit; } // cbmcp-guard\n";

	private static function snippets_dir() {
		return self::protected_dir( 'cbmcp-snippets' );
	}

	private static function get_snippets() {
		$s = get_option( self::SNIPPET_OPTION, array() );
		return is_array( $s ) ? $s : array();
	}

	private static function valid_name( $name ) {
		return is_string( $name ) && preg_match( '/^[a-z0-9][a-z0-9_-]{0,63}$/', $name );
	}

	private static function disable_snippet( $name, $error ) {
		$all = self::get_snippets();
		if ( isset( $all[ $name ] ) ) {
			$all[ $name ]['active']   = false;
			$all[ $name ]['error']    = $error;
			$all[ $name ]['disabled'] = gmdate( 'c' );
			update_option( self::SNIPPET_OPTION, $all, true );
		}
	}

	/** Runs active snippets; a snippet that throws or fatals is switched off automatically. */
	public static function run_snippets() {
		if ( ( defined( 'CBMCP_SAFE_MODE' ) && CBMCP_SAFE_MODE ) || ! self::snippets_enabled() ) {
			return;
		}
		$all = self::get_snippets();
		if ( empty( $all ) ) {
			return;
		}
		$dir = wp_normalize_path( self::content_dir() . '/cbmcp-snippets' );

		register_shutdown_function(
			function () use ( $dir ) {
				$e = error_get_last();
				if ( ! $e || ! in_array( $e['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_RECOVERABLE_ERROR ), true ) ) {
					return;
				}
				$file = wp_normalize_path( (string) $e['file'] );
				if ( 0 === strpos( $file, $dir . '/' ) ) {
					CBMCP_Bridge::disable_snippet_public( basename( $file, '.php' ), $e['message'] . ' (line ' . $e['line'] . ')' );
				}
			}
		);

		foreach ( $all as $name => $meta ) {
			if ( empty( $meta['active'] ) || ! self::valid_name( $name ) ) {
				continue;
			}
			$file = $dir . '/' . $name . '.php';
			if ( ! is_file( $file ) ) {
				continue;
			}
			self::$running_snippet = $name;
			try {
				include $file;
			} catch ( \Throwable $e ) {
				self::disable_snippet( $name, get_class( $e ) . ': ' . $e->getMessage() . ' (line ' . $e->getLine() . ')' );
			}
			self::$running_snippet = null;
		}
	}

	/** @internal used by the shutdown handler */
	public static function disable_snippet_public( $name, $error ) {
		if ( self::valid_name( $name ) ) {
			self::disable_snippet( $name, $error );
		}
	}

	private static function snippet_code_from_file( $file ) {
		$code = (string) @file_get_contents( $file ); // phpcs:ignore
		if ( 0 === strpos( $code, self::SNIPPET_GUARD ) ) {
			$code = "<?php\n" . substr( $code, strlen( self::SNIPPET_GUARD ) );
		}
		return $code;
	}

	public static function route_snippets_list() {
		$out = array();
		foreach ( self::get_snippets() as $name => $meta ) {
			$out[] = array_merge( array( 'name' => $name ), $meta );
		}
		return array(
			'enabled'   => self::snippets_enabled(),
			'safe_mode' => defined( 'CBMCP_SAFE_MODE' ) && CBMCP_SAFE_MODE,
			'snippets'  => $out,
		);
	}

	public static function route_snippets_get( WP_REST_Request $req ) {
		$name = (string) $req->get_param( 'name' );
		$all  = self::get_snippets();
		if ( ! self::valid_name( $name ) || ! isset( $all[ $name ] ) ) {
			return self::err( 'cbmcp_no_snippet', 'Snippet not found.', 404 );
		}
		return array_merge(
			array(
				'name' => $name,
				'code' => self::snippet_code_from_file( self::snippets_dir() . '/' . $name . '.php' ),
			),
			$all[ $name ]
		);
	}

	public static function route_snippets_save( WP_REST_Request $req ) {
		if ( ! self::snippets_enabled() ) {
			return self::err( 'cbmcp_snippets_disabled', 'Snippets are disabled (CBMCP_DISABLE_SNIPPETS).', 403 );
		}
		$name = (string) $req->get_param( 'name' );
		if ( ! self::valid_name( $name ) ) {
			return self::err( 'cbmcp_bad_name', 'Name must match [a-z0-9][a-z0-9_-]{0,63}.' );
		}
		$code = (string) $req->get_param( 'code' );
		$code = preg_replace( '/^\xEF\xBB\xBF/', '', $code );
		$code = preg_replace( '/^\s*<\?php\b/', '', $code );
		$full = self::SNIPPET_GUARD . ltrim( $code, "\r\n" );

		$lint = self::lint_php( $full );
		if ( is_wp_error( $lint ) ) {
			return self::err( 'cbmcp_php_syntax', $lint->get_error_message() . ' (line numbers include 2 guard lines)', 422 );
		}

		$file = self::snippets_dir() . '/' . $name . '.php';
		if ( false === @file_put_contents( $file, $full, LOCK_EX ) ) { // phpcs:ignore
			return self::err( 'cbmcp_write_failed', 'Could not write snippet file.', 500 );
		}
		self::after_write( $file );

		$active = $req->get_param( 'active' );
		$active = null === $active ? true : filter_var( $active, FILTER_VALIDATE_BOOLEAN );
		$all    = self::get_snippets();
		$all[ $name ] = array(
			'description' => (string) $req->get_param( 'description' ),
			'active'      => $active,
			'updated'     => gmdate( 'c' ),
			'error'       => null,
		);
		update_option( self::SNIPPET_OPTION, $all, true );

		return array(
			'saved'  => $name,
			'active' => $active,
			'note'   => 'Runs on the next request. Use fetch_page to verify; failing snippets are disabled automatically.',
		);
	}

	public static function route_snippets_toggle( WP_REST_Request $req ) {
		$name = (string) $req->get_param( 'name' );
		$all  = self::get_snippets();
		if ( ! self::valid_name( $name ) || ! isset( $all[ $name ] ) ) {
			return self::err( 'cbmcp_no_snippet', 'Snippet not found.', 404 );
		}
		$active = filter_var( $req->get_param( 'active' ), FILTER_VALIDATE_BOOLEAN );
		if ( $active && ! self::snippets_enabled() ) {
			return self::err( 'cbmcp_snippets_disabled', 'Snippets are disabled (CBMCP_DISABLE_SNIPPETS).', 403 );
		}
		$all[ $name ]['active'] = $active;
		if ( $active ) {
			$all[ $name ]['error'] = null;
		}
		update_option( self::SNIPPET_OPTION, $all, true );
		return array(
			'name'   => $name,
			'active' => $active,
		);
	}

	public static function route_snippets_delete( WP_REST_Request $req ) {
		$name = (string) $req->get_param( 'name' );
		$all  = self::get_snippets();
		if ( ! self::valid_name( $name ) || ! isset( $all[ $name ] ) ) {
			return self::err( 'cbmcp_no_snippet', 'Snippet not found.', 404 );
		}
		unset( $all[ $name ] );
		update_option( self::SNIPPET_OPTION, $all, true );
		$file = self::snippets_dir() . '/' . $name . '.php';
		if ( is_file( $file ) ) {
			@unlink( $file ); // phpcs:ignore
		}
		return array( 'deleted' => $name );
	}

	// ------------------------------------------------------------------
	// Options
	// ------------------------------------------------------------------

	private static function option_name( WP_REST_Request $req ) {
		$name = (string) $req->get_param( 'name' );
		if ( '' === $name || strlen( $name ) > 191 ) {
			return self::err( 'cbmcp_bad_option', 'Invalid option name.' );
		}
		return $name;
	}

	public static function route_option_get( WP_REST_Request $req ) {
		$name = self::option_name( $req );
		if ( is_wp_error( $name ) ) {
			return $name;
		}
		$sentinel = '__cbmcp_missing__';
		$value    = get_option( $name, $sentinel );
		return array(
			'name'   => $name,
			'exists' => $sentinel !== $value,
			'value'  => $sentinel === $value ? null : $value,
		);
	}

	public static function route_option_set( WP_REST_Request $req ) {
		$name = self::option_name( $req );
		if ( is_wp_error( $name ) ) {
			return $name;
		}
		if ( in_array( $name, self::PROTECTED_OPTIONS, true ) ) {
			return self::err( 'cbmcp_protected_option', "Option \"$name\" is protected. Use the dedicated tools/settings.", 403 );
		}
		$autoload = $req->get_param( 'autoload' );
		$autoload = null === $autoload ? null : filter_var( $autoload, FILTER_VALIDATE_BOOLEAN );
		$value    = $req->get_param( 'value' );
		$changed  = update_option( $name, $value, $autoload );
		return array(
			'name'    => $name,
			'changed' => $changed,
			'value'   => get_option( $name ),
		);
	}

	public static function route_option_delete( WP_REST_Request $req ) {
		$name = self::option_name( $req );
		if ( is_wp_error( $name ) ) {
			return $name;
		}
		if ( in_array( $name, self::PROTECTED_OPTIONS, true ) ) {
			return self::err( 'cbmcp_protected_option', "Option \"$name\" is protected.", 403 );
		}
		return array(
			'name'    => $name,
			'deleted' => delete_option( $name ),
		);
	}

	// ------------------------------------------------------------------
	// Cache & theme
	// ------------------------------------------------------------------

	public static function route_cache_flush( WP_REST_Request $req ) {
		$done = array();
		if ( wp_cache_flush() ) {
			$done[] = 'object-cache';
		}
		if ( filter_var( $req->get_param( 'rewrite_rules' ), FILTER_VALIDATE_BOOLEAN ) ) {
			flush_rewrite_rules( false );
			$done[] = 'rewrite-rules';
		}
		if ( function_exists( 'rocket_clean_domain' ) ) {
			rocket_clean_domain();
			$done[] = 'wp-rocket';
		}
		if ( function_exists( 'w3tc_flush_all' ) ) {
			w3tc_flush_all();
			$done[] = 'w3-total-cache';
		}
		if ( function_exists( 'wp_cache_clear_cache' ) ) {
			wp_cache_clear_cache();
			$done[] = 'wp-super-cache';
		}
		if ( defined( 'LSCWP_V' ) ) {
			do_action( 'litespeed_purge_all' );
			$done[] = 'litespeed';
		}
		if ( class_exists( 'autoptimizeCache' ) && method_exists( 'autoptimizeCache', 'clearall' ) ) {
			autoptimizeCache::clearall();
			$done[] = 'autoptimize';
		}
		if ( function_exists( 'sg_cachepress_purge_cache' ) ) {
			sg_cachepress_purge_cache();
			$done[] = 'siteground';
		}
		if ( class_exists( 'Breeze_Admin' ) ) {
			do_action( 'breeze_clear_all_cache' );
			$done[] = 'breeze';
		}
		if ( isset( $GLOBALS['wp_fastest_cache'] ) && method_exists( $GLOBALS['wp_fastest_cache'], 'deleteCache' ) ) {
			$GLOBALS['wp_fastest_cache']->deleteCache( true );
			$done[] = 'wp-fastest-cache';
		}
		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
			$done[] = 'elementor-css';
		}
		if ( class_exists( 'ET_Core_PageResource' ) && method_exists( 'ET_Core_PageResource', 'remove_static_resources' ) ) {
			ET_Core_PageResource::remove_static_resources( 'all', 'all' );
			$done[] = 'divi';
		}
		if ( class_exists( 'FLBuilderModel' ) && method_exists( 'FLBuilderModel', 'delete_asset_cache_for_all_posts' ) ) {
			FLBuilderModel::delete_asset_cache_for_all_posts();
			$done[] = 'beaver-builder';
		}
		do_action( 'cbmcp_flush_cache' );
		return array( 'flushed' => $done );
	}

	public static function route_theme_activate( WP_REST_Request $req ) {
		$stylesheet = sanitize_text_field( (string) $req->get_param( 'stylesheet' ) );
		$theme      = wp_get_theme( $stylesheet );
		if ( ! $theme->exists() ) {
			return self::err( 'cbmcp_no_theme', 'Theme not found.', 404 );
		}
		if ( $theme->errors() ) {
			return self::err( 'cbmcp_broken_theme', 'Theme has errors: ' . $theme->errors()->get_error_message() );
		}
		$previous = get_stylesheet();
		switch_theme( $theme->get_stylesheet() );
		return array(
			'active'   => get_stylesheet(),
			'previous' => $previous,
		);
	}

	// ------------------------------------------------------------------
	// Backups (generic helpers for meta)
	// ------------------------------------------------------------------

	private static function list_backup_files( $prefix, $suffix ) {
		$dir = self::protected_dir( 'cbmcp-backups' );
		$out = array();
		foreach ( (array) scandir( $dir ) as $f ) {
			if ( 0 === strpos( $f, $prefix ) && substr( $f, -strlen( $suffix ) ) === $suffix ) {
				$out[] = $f;
			}
		}
		rsort( $out );
		return $out;
	}

	// ------------------------------------------------------------------
	// Meta (post, term, user, comment) – including protected "_" keys
	// ------------------------------------------------------------------

	private static function meta_target( WP_REST_Request $req ) {
		$type = $req->get_param( 'object_type' ) ? (string) $req->get_param( 'object_type' ) : 'post';
		$id   = (int) $req->get_param( 'object_id' );
		if ( ! in_array( $type, array( 'post', 'term', 'user', 'comment' ), true ) ) {
			return self::err( 'cbmcp_bad_type', 'object_type must be post, term, user or comment.' );
		}
		$exists = false;
		if ( $id > 0 ) {
			switch ( $type ) {
				case 'post':
					$exists = (bool) get_post( $id );
					break;
				case 'term':
					$exists = (bool) get_term( $id );
					break;
				case 'user':
					$exists = (bool) get_userdata( $id );
					break;
				case 'comment':
					$exists = (bool) get_comment( $id );
					break;
			}
		}
		if ( ! $exists ) {
			return self::err( 'cbmcp_not_found', "$type #$id not found.", 404 );
		}
		return array( $type, $id );
	}

	private static function meta_key_param( WP_REST_Request $req ) {
		$key = (string) $req->get_param( 'key' );
		if ( '' === $key || strlen( $key ) > 255 ) {
			return self::err( 'cbmcp_bad_key', 'Invalid meta key.' );
		}
		return $key;
	}

	private static function meta_backup_prefix( $type, $id, $key ) {
		return 'meta__' . $type . '__' . $id . '__' . preg_replace( '/[^A-Za-z0-9_-]/', '-', $key ) . '.';
	}

	private static function meta_backup( $type, $id, $key ) {
		$exists = metadata_exists( $type, $id, $key );
		$data   = array(
			'object_type' => $type,
			'object_id'   => $id,
			'key'         => $key,
			'existed'     => $exists,
			'values'      => $exists ? get_metadata( $type, $id, $key, false ) : array(),
			'time'        => gmdate( 'c' ),
		);
		$dir    = self::protected_dir( 'cbmcp-backups' );
		$prefix = self::meta_backup_prefix( $type, $id, $key );
		$name   = $prefix . self::backup_stamp() . '.json';
		if ( false === @file_put_contents( $dir . '/' . $name, wp_json_encode( $data ) ) ) { // phpcs:ignore
			return null;
		}
		foreach ( array_slice( self::list_backup_files( $prefix, '.json' ), self::KEEP_BACKUPS ) as $old ) {
			@unlink( $dir . '/' . $old ); // phpcs:ignore
		}
		return $name;
	}

	private static function after_meta_change( $type, $id, $key ) {
		if ( 'post' !== $type ) {
			return;
		}
		// Elementor renders CSS from _elementor_data; force regeneration.
		if ( 0 === strpos( $key, '_elementor' ) && '_elementor_css' !== $key ) {
			delete_post_meta( $id, '_elementor_css' );
			if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
				\Elementor\Plugin::$instance->files_manager->clear_cache();
			}
		}
		clean_post_cache( $id );
	}

	public static function route_meta_get( WP_REST_Request $req ) {
		$t = self::meta_target( $req );
		if ( is_wp_error( $t ) ) {
			return $t;
		}
		list( $type, $id ) = $t;
		$keys   = $req->get_param( 'keys' );
		$keys   = $keys ? (array) $keys : array();
		$prefix = (string) $req->get_param( 'prefix' );
		$all    = get_metadata( $type, $id );
		$out    = array();
		foreach ( (array) $all as $k => $vals ) {
			if ( $keys && ! in_array( $k, $keys, true ) ) {
				continue;
			}
			if ( '' !== $prefix && 0 !== strpos( $k, $prefix ) ) {
				continue;
			}
			$vals      = array_map( 'maybe_unserialize', (array) $vals );
			$out[ $k ] = 1 === count( $vals ) ? $vals[0] : $vals;
		}
		ksort( $out );
		return array(
			'object_type' => $type,
			'object_id'   => $id,
			'count'       => count( $out ),
			'meta'        => (object) $out,
		);
	}

	public static function route_meta_set( WP_REST_Request $req ) {
		$t = self::meta_target( $req );
		if ( is_wp_error( $t ) ) {
			return $t;
		}
		list( $type, $id ) = $t;
		$key = self::meta_key_param( $req );
		if ( is_wp_error( $key ) ) {
			return $key;
		}
		$json   = $req->get_json_params();
		$value  = is_array( $json ) && array_key_exists( 'value', $json ) ? $json['value'] : $req->get_param( 'value' );
		$backup = self::meta_backup( $type, $id, $key );
		$before = metadata_exists( $type, $id, $key );
		// update_metadata() unslashes its input, so slash it first (keeps JSON backslashes intact).
		$result = update_metadata( $type, $id, $key, wp_slash( $value ) );
		self::after_meta_change( $type, $id, $key );
		return array(
			'object_type' => $type,
			'object_id'   => $id,
			'key'         => $key,
			'created'     => ! $before,
			'changed'     => false !== $result,
			'backup'      => $backup,
		);
	}

	public static function route_meta_delete( WP_REST_Request $req ) {
		$t = self::meta_target( $req );
		if ( is_wp_error( $t ) ) {
			return $t;
		}
		list( $type, $id ) = $t;
		$key = self::meta_key_param( $req );
		if ( is_wp_error( $key ) ) {
			return $key;
		}
		$backup = self::meta_backup( $type, $id, $key );
		$ok     = delete_metadata( $type, $id, $key );
		self::after_meta_change( $type, $id, $key );
		return array(
			'key'     => $key,
			'deleted' => $ok,
			'backup'  => $backup,
		);
	}

	public static function route_meta_backups( WP_REST_Request $req ) {
		$t = self::meta_target( $req );
		if ( is_wp_error( $t ) ) {
			return $t;
		}
		list( $type, $id ) = $t;
		$key = self::meta_key_param( $req );
		if ( is_wp_error( $key ) ) {
			return $key;
		}
		return array(
			'key'     => $key,
			'backups' => self::list_backup_files( self::meta_backup_prefix( $type, $id, $key ), '.json' ),
		);
	}

	public static function route_meta_restore( WP_REST_Request $req ) {
		$t = self::meta_target( $req );
		if ( is_wp_error( $t ) ) {
			return $t;
		}
		list( $type, $id ) = $t;
		$key = self::meta_key_param( $req );
		if ( is_wp_error( $key ) ) {
			return $key;
		}
		$all = self::list_backup_files( self::meta_backup_prefix( $type, $id, $key ), '.json' );
		if ( empty( $all ) ) {
			return self::err( 'cbmcp_no_backup', 'No backup found.', 404 );
		}
		$name = $req->get_param( 'backup' ) ? basename( (string) $req->get_param( 'backup' ) ) : $all[0];
		if ( ! in_array( $name, $all, true ) ) {
			return self::err( 'cbmcp_no_backup', 'Unknown backup name.', 404 );
		}
		$data = json_decode( (string) file_get_contents( self::protected_dir( 'cbmcp-backups' ) . '/' . $name ), true ); // phpcs:ignore
		if ( ! is_array( $data ) || ( $data['key'] ?? null ) !== $key ) {
			return self::err( 'cbmcp_bad_backup', 'Backup file is invalid.', 500 );
		}
		$current = self::meta_backup( $type, $id, $key );
		delete_metadata( $type, $id, $key );
		if ( ! empty( $data['existed'] ) ) {
			foreach ( (array) $data['values'] as $v ) {
				add_metadata( $type, $id, $key, wp_slash( $v ) );
			}
		}
		self::after_meta_change( $type, $id, $key );
		return array(
			'restored'           => $key,
			'from'               => $name,
			'backup_of_replaced' => $current,
		);
	}

	// ------------------------------------------------------------------
	// Database
	// ------------------------------------------------------------------

	private static function db_write_enabled() {
		return defined( 'CBMCP_ALLOW_DB_WRITE' ) && CBMCP_ALLOW_DB_WRITE;
	}

	/** Remove string literals, quoted identifiers and comments for keyword checks. */
	private static function sql_skeleton( $sql ) {
		$s = preg_replace( "/'(?:[^'\\\\]|\\\\.|'')*'/s", "''", $sql );
		$s = preg_replace( '/"(?:[^"\\\\]|\\\\.|"")*"/s', '""', $s );
		$s = preg_replace( '/`[^`]*`/', '``', $s );
		$s = preg_replace( '~/\*.*?\*/~s', ' ', $s );
		$s = preg_replace( '/(--\s|#)[^\n]*/', ' ', $s );
		return $s;
	}

	public static function route_db_schema( WP_REST_Request $req ) {
		global $wpdb;
		$table = (string) $req->get_param( 'table' );
		$prev  = $wpdb->hide_errors();
		if ( '' !== $table ) {
			$table = str_replace( '{prefix}', $wpdb->prefix, $table );
			if ( ! preg_match( '/^[A-Za-z0-9_$]+$/', $table ) ) {
				return self::err( 'cbmcp_bad_table', 'Invalid table name.' );
			}
			$cols = $wpdb->get_results( "SHOW COLUMNS FROM `$table`", ARRAY_A ); // phpcs:ignore
			$idx  = $wpdb->get_results( "SHOW INDEX FROM `$table`", ARRAY_A ); // phpcs:ignore
			$cnt  = $wpdb->get_var( "SELECT COUNT(*) FROM `$table`" ); // phpcs:ignore
			$err  = $wpdb->last_error;
			$wpdb->show_errors( $prev );
			if ( $err ) {
				return self::err( 'cbmcp_db_error', $err );
			}
			return array(
				'table'   => $table,
				'rows'    => (int) $cnt,
				'columns' => $cols,
				'indexes' => array_values(
					array_unique(
						array_map(
							function ( $i ) {
								return $i['Key_name'];
							},
							(array) $idx
						)
					)
				),
			);
		}
		$like   = (string) $req->get_param( 'like' );
		$status = $wpdb->get_results( 'SHOW TABLE STATUS', ARRAY_A );
		$wpdb->show_errors( $prev );
		$out = array();
		foreach ( (array) $status as $t ) {
			if ( '' !== $like && false === stripos( $t['Name'], $like ) ) {
				continue;
			}
			$out[] = array(
				'name'        => $t['Name'],
				'rows_approx' => (int) $t['Rows'],
				'size_kb'     => (int) round( ( (int) $t['Data_length'] + (int) $t['Index_length'] ) / 1024 ),
				'engine'      => $t['Engine'],
			);
		}
		return array(
			'prefix'   => $wpdb->prefix,
			'db_write' => self::db_write_enabled(),
			'tables'   => $out,
		);
	}

	public static function route_db_query( WP_REST_Request $req ) {
		global $wpdb;
		$sql = trim( (string) $req->get_param( 'sql' ) );
		$sql = preg_replace( '/;\s*$/', '', $sql );
		$sql = str_replace( '{prefix}', $wpdb->prefix, $sql );
		if ( '' === $sql ) {
			return self::err( 'cbmcp_empty_sql', 'sql is required.' );
		}
		$skel = self::sql_skeleton( $sql );
		if ( false !== strpos( $skel, ';' ) ) {
			return self::err( 'cbmcp_multi_statement', 'Only one statement per request.' );
		}
		if ( preg_match( '/\b(INTO\s+(OUT|DUMP)FILE|LOAD_FILE\s*\(|LOAD\s+DATA|SLEEP\s*\(|BENCHMARK\s*\()/i', $skel ) ) {
			return self::err( 'cbmcp_forbidden_sql', 'This SQL construct is not allowed.', 403 );
		}
		$first     = strtoupper( (string) strtok( ltrim( $skel, " \t\r\n(" ), " \t\r\n(" ) );
		$has_write = (bool) preg_match( '/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|RENAME|LOCK|CALL|HANDLER|SET)\b/i', $skel );
		$is_read   = in_array( $first, array( 'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH' ), true ) && ! $has_write;
		$prev      = $wpdb->hide_errors();

		if ( ! $is_read ) {
			if ( ! self::db_write_enabled() ) {
				$wpdb->show_errors( $prev );
				return self::err( 'cbmcp_db_readonly', "Write queries are disabled. Add define( 'CBMCP_ALLOW_DB_WRITE', true ); to wp-config.php to allow INSERT/UPDATE/DELETE/REPLACE.", 403 );
			}
			if ( ! filter_var( $req->get_param( 'allow_write' ), FILTER_VALIDATE_BOOLEAN ) ) {
				$wpdb->show_errors( $prev );
				return self::err( 'cbmcp_db_write_flag', 'This is a write query: set allow_write=true.' );
			}
			if ( ! in_array( $first, array( 'INSERT', 'UPDATE', 'DELETE', 'REPLACE' ), true ) || preg_match( '/\b(DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|RENAME)\b/i', $skel ) ) {
				$wpdb->show_errors( $prev );
				return self::err( 'cbmcp_db_ddl', 'Only INSERT, UPDATE, DELETE and REPLACE are allowed (no schema changes).', 403 );
			}
			if ( in_array( $first, array( 'UPDATE', 'DELETE' ), true ) && ! preg_match( '/\bWHERE\b/i', $skel ) ) {
				$wpdb->show_errors( $prev );
				return self::err( 'cbmcp_db_no_where', 'UPDATE/DELETE without WHERE is not allowed.' );
			}
			$res = $wpdb->query( $sql ); // phpcs:ignore
			$err = $wpdb->last_error;
			$wpdb->show_errors( $prev );
			if ( false === $res ) {
				return self::err( 'cbmcp_db_error', $err ? $err : 'Query failed.' );
			}
			wp_cache_flush();
			return array(
				'rows_affected' => (int) $res,
				'insert_id'     => (int) $wpdb->insert_id,
			);
		}

		$max = (int) $req->get_param( 'max_rows' );
		$max = $max > 0 ? min( 2000, $max ) : 200;
		if ( 'SELECT' === $first && ! preg_match( '/\bLIMIT\s+\d/i', $skel ) ) {
			$sql .= ' LIMIT ' . ( $max + 1 );
		}
		$rows = $wpdb->get_results( $sql, ARRAY_A ); // phpcs:ignore
		$err  = $wpdb->last_error;
		$wpdb->show_errors( $prev );
		if ( $err ) {
			return self::err( 'cbmcp_db_error', $err );
		}
		$rows  = (array) $rows;
		$total = count( $rows );
		return array(
			'returned'  => min( $total, $max ),
			'truncated' => $total > $max,
			'rows'      => array_slice( $rows, 0, $max ),
		);
	}

	// ------------------------------------------------------------------
	// Cron
	// ------------------------------------------------------------------

	const PAUSED_CRON_OPTION = 'cbmcp_paused_cron';

	public static function route_cron_list( WP_REST_Request $req ) {
		$search = (string) $req->get_param( 'search' );
		$now    = time();
		$events = array();
		foreach ( (array) _get_cron_array() as $ts => $hooks ) {
			foreach ( (array) $hooks as $hook => $items ) {
				if ( '' !== $search && false === stripos( $hook, $search ) ) {
					continue;
				}
				foreach ( (array) $items as $e ) {
					$events[] = array(
						'hook'         => $hook,
						'timestamp'    => (int) $ts,
						'next_run_utc' => gmdate( 'c', (int) $ts ),
						'in_seconds'   => (int) $ts - $now,
						'late'         => (int) $ts < $now - 600,
						'schedule'     => $e['schedule'] ? $e['schedule'] : 'single',
						'interval'     => isset( $e['interval'] ) ? (int) $e['interval'] : null,
						'args'         => $e['args'],
						'has_callback' => false !== has_action( $hook ),
					);
				}
			}
		}
		$schedules = array();
		foreach ( wp_get_schedules() as $name => $s ) {
			$schedules[ $name ] = array(
				'interval' => $s['interval'],
				'display'  => $s['display'],
			);
		}
		return array(
			'now_utc'         => gmdate( 'c', $now ),
			'disable_wp_cron' => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
			'alternate_cron'  => defined( 'ALTERNATE_WP_CRON' ) && ALTERNATE_WP_CRON,
			'count'           => count( $events ),
			'events'          => $events,
			'paused'          => array_values( (array) get_option( self::PAUSED_CRON_OPTION, array() ) ),
			'schedules'       => $schedules,
		);
	}

	private static function cron_args( WP_REST_Request $req ) {
		$args = $req->get_param( 'args' );
		return is_array( $args ) ? array_values( $args ) : array();
	}

	public static function route_cron_run( WP_REST_Request $req ) {
		$hook = (string) $req->get_param( 'hook' );
		if ( '' === $hook ) {
			return self::err( 'cbmcp_no_hook', 'hook is required.' );
		}
		$args  = self::cron_args( $req );
		$start = microtime( true );
		$error = null;
		ob_start();
		try {
			do_action_ref_array( $hook, $args );
		} catch ( \Throwable $e ) {
			$error = get_class( $e ) . ': ' . $e->getMessage() . ' in ' . basename( $e->getFile() ) . ':' . $e->getLine();
		}
		$output = (string) ob_get_clean();
		return array(
			'hook'         => $hook,
			'had_callback' => false !== has_action( $hook ),
			'duration_ms'  => (int) round( ( microtime( true ) - $start ) * 1000 ),
			'error'        => $error,
			'output'       => mb_substr( $output, 0, 4000 ),
		);
	}

	public static function route_cron_pause( WP_REST_Request $req ) {
		$hook = (string) $req->get_param( 'hook' );
		$args = self::cron_args( $req );
		$ts   = (int) $req->get_param( 'timestamp' );
		$evt  = wp_get_scheduled_event( $hook, $args, $ts ? $ts : null );
		if ( ! $evt ) {
			return self::err( 'cbmcp_no_event', 'Scheduled event not found (check hook and args).', 404 );
		}
		$paused                                  = (array) get_option( self::PAUSED_CRON_OPTION, array() );
		$paused[ md5( $hook . wp_json_encode( $args ) ) ] = array(
			'hook'      => $hook,
			'args'      => $args,
			'schedule'  => $evt->schedule ? $evt->schedule : false,
			'next'      => (int) $evt->timestamp,
			'paused_at' => gmdate( 'c' ),
		);
		update_option( self::PAUSED_CRON_OPTION, $paused, false );
		wp_unschedule_event( $evt->timestamp, $hook, $args );
		return array(
			'paused' => $hook,
			'note'   => 'Some plugins re-schedule their own events on the next page load. Check with manage_cron action=list.',
		);
	}

	public static function route_cron_resume( WP_REST_Request $req ) {
		$hook   = (string) $req->get_param( 'hook' );
		$args   = self::cron_args( $req );
		$paused = (array) get_option( self::PAUSED_CRON_OPTION, array() );
		$key    = md5( $hook . wp_json_encode( $args ) );
		if ( ! isset( $paused[ $key ] ) ) {
			return self::err( 'cbmcp_not_paused', 'This event is not paused.', 404 );
		}
		$p    = $paused[ $key ];
		$next = max( time() + 60, (int) $p['next'] );
		if ( ! wp_next_scheduled( $hook, $args ) ) {
			if ( $p['schedule'] ) {
				wp_schedule_event( $next, $p['schedule'], $hook, $args );
			} else {
				wp_schedule_single_event( $next, $hook, $args );
			}
		}
		unset( $paused[ $key ] );
		update_option( self::PAUSED_CRON_OPTION, $paused, false );
		return array(
			'resumed'      => $hook,
			'next_run_utc' => gmdate( 'c', $next ),
		);
	}

	// ------------------------------------------------------------------
	// Mail
	// ------------------------------------------------------------------

	public static function route_mail_test( WP_REST_Request $req ) {
		$to = sanitize_email( (string) $req->get_param( 'to' ) );
		if ( ! is_email( $to ) ) {
			return self::err( 'cbmcp_bad_email', 'Valid "to" address required.' );
		}
		$site    = wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES );
		$subject = $req->get_param( 'subject' ) ? (string) $req->get_param( 'subject' ) : "Test email from $site";
		$message = $req->get_param( 'message' ) ? (string) $req->get_param( 'message' ) : "This is a test email sent by the Code & Blocks MCP Bridge from $site (" . home_url() . ').';
		$error   = null;
		$catch   = function ( $e ) use ( &$error ) {
			$error = $e->get_error_message();
		};
		add_action( 'wp_mail_failed', $catch );
		$sent = wp_mail( $to, $subject, $message );
		remove_action( 'wp_mail_failed', $catch );

		$host = (string) wp_parse_url( network_home_url(), PHP_URL_HOST );
		if ( 0 === strpos( $host, 'www.' ) ) {
			$host = substr( $host, 4 );
		}
		$mail_plugins = array();
		foreach ( (array) get_option( 'active_plugins', array() ) as $p ) {
			if ( preg_match( '/smtp|mail|sendgrid|mailgun|postmark|brevo|sendinblue|\bses\b|sparkpost|mailjet/i', $p ) ) {
				$mail_plugins[] = $p;
			}
		}
		return array(
			'sent'         => (bool) $sent,
			'error'        => $error,
			'to'           => $to,
			'from_email'   => apply_filters( 'wp_mail_from', 'wordpress@' . $host ),
			'from_name'    => apply_filters( 'wp_mail_from_name', 'WordPress' ),
			'admin_email'  => get_option( 'admin_email' ),
			'mail_plugins' => $mail_plugins,
			'note'         => $sent ? 'WordPress handed the message to the mailer. Delivery to the inbox is not guaranteed (check spam).' : null,
		);
	}

	// ------------------------------------------------------------------
	// Post copies (test page-builder changes on a draft, then apply)
	// ------------------------------------------------------------------

	const SKIP_COPY_META = array( '_edit_lock', '_edit_last', '_wp_old_slug', '_wp_old_date', '_elementor_css', '_cbmcp_copy_of', '_cbmcp_backup_of', '_wp_trash_meta_status', '_wp_trash_meta_time', '_wp_desired_post_slug' );

	private static function copy_meta( $from, $to, $replace ) {
		global $wpdb;
		if ( $replace ) {
			$existing = $wpdb->get_col( $wpdb->prepare( "SELECT DISTINCT meta_key FROM {$wpdb->postmeta} WHERE post_id = %d", $to ) );
			foreach ( $existing as $k ) {
				if ( ! in_array( $k, self::SKIP_COPY_META, true ) ) {
					delete_post_meta( $to, $k );
				}
			}
		}
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT meta_key, meta_value FROM {$wpdb->postmeta} WHERE post_id = %d ORDER BY meta_id", $from ) );
		foreach ( $rows as $r ) {
			if ( in_array( $r->meta_key, self::SKIP_COPY_META, true ) ) {
				continue;
			}
			add_post_meta( $to, $r->meta_key, wp_slash( maybe_unserialize( $r->meta_value ) ) );
		}
	}

	private static function copy_post( WP_Post $src, array $overrides ) {
		$data = array_merge(
			array(
				'post_title'            => $src->post_title,
				'post_content'          => $src->post_content,
				'post_content_filtered' => $src->post_content_filtered,
				'post_excerpt'          => $src->post_excerpt,
				'post_status'           => 'draft',
				'post_type'             => $src->post_type,
				'post_parent'           => $src->post_parent,
				'menu_order'            => $src->menu_order,
				'post_author'           => get_current_user_id(),
				'comment_status'        => $src->comment_status,
				'ping_status'           => $src->ping_status,
				'post_password'         => $src->post_password,
			),
			$overrides
		);
		$id = wp_insert_post( wp_slash( $data ), true );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		self::copy_meta( $src->ID, $id, false );
		foreach ( get_object_taxonomies( $src->post_type ) as $tax ) {
			$terms = wp_get_object_terms( $src->ID, $tax, array( 'fields' => 'ids' ) );
			if ( ! is_wp_error( $terms ) && $terms ) {
				wp_set_object_terms( $id, $terms, $tax );
			}
		}
		return $id;
	}

	public static function route_posts_duplicate( WP_REST_Request $req ) {
		$src = get_post( (int) $req->get_param( 'id' ) );
		if ( ! $src || 'revision' === $src->post_type ) {
			return self::err( 'cbmcp_not_found', 'Post not found.', 404 );
		}
		$status = $req->get_param( 'status' ) ? sanitize_key( $req->get_param( 'status' ) ) : 'draft';
		if ( ! in_array( $status, array( 'draft', 'pending', 'private' ), true ) ) {
			$status = 'draft';
		}
		$title = $req->get_param( 'title' ) ? (string) $req->get_param( 'title' ) : $src->post_title . ' (Copy)';
		$id    = self::copy_post(
			$src,
			array(
				'post_status' => $status,
				'post_title'  => $title,
			)
		);
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		update_post_meta( $id, '_cbmcp_copy_of', $src->ID );
		$preview = self::make_preview( array( 'post_id' => $id ), 120 );
		return array(
			'id'          => $id,
			'copy_of'     => $src->ID,
			'status'      => $status,
			'edit_url'    => admin_url( 'post.php?post=' . $id . '&action=edit' ),
			'preview_url' => $preview['url'],
		);
	}

	public static function route_posts_apply( WP_REST_Request $req ) {
		$src = get_post( (int) $req->get_param( 'source_id' ) );
		$dst = get_post( (int) $req->get_param( 'target_id' ) );
		if ( ! $src || ! $dst ) {
			return self::err( 'cbmcp_not_found', 'source_id or target_id not found.', 404 );
		}
		if ( $src->ID === $dst->ID ) {
			return self::err( 'cbmcp_same_post', 'source_id and target_id are the same post.' );
		}
		if ( $src->post_type !== $dst->post_type ) {
			return self::err( 'cbmcp_type_mismatch', 'Both posts must have the same post type.' );
		}
		$backup_id = null;
		if ( false !== filter_var( $req->get_param( 'backup' ) ?? true, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE ) ) {
			$backup_id = self::copy_post(
				$dst,
				array(
					'post_status' => 'draft',
					'post_title'  => '[Backup ' . current_time( 'Y-m-d H:i' ) . '] ' . $dst->post_title,
				)
			);
			if ( is_wp_error( $backup_id ) ) {
				return $backup_id;
			}
			update_post_meta( $backup_id, '_cbmcp_backup_of', $dst->ID );
		}
		$update = array(
			'ID'                    => $dst->ID,
			'post_content'          => $src->post_content,
			'post_content_filtered' => $src->post_content_filtered,
			'post_excerpt'          => $src->post_excerpt,
		);
		if ( filter_var( $req->get_param( 'copy_title' ), FILTER_VALIDATE_BOOLEAN ) ) {
			$update['post_title'] = $src->post_title;
		}
		$r = wp_update_post( wp_slash( $update ), true );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		self::copy_meta( $src->ID, $dst->ID, true );
		self::after_meta_change( 'post', $dst->ID, '_elementor_data' );

		$deleted = false;
		if ( ! filter_var( $req->get_param( 'keep_source' ), FILTER_VALIDATE_BOOLEAN ) ) {
			$deleted = (bool) wp_delete_post( $src->ID, true );
		}
		return array(
			'applied_to'     => $dst->ID,
			'from'           => $src->ID,
			'backup_post_id' => $backup_id,
			'source_deleted' => $deleted,
			'url'            => get_permalink( $dst->ID ),
			'note'           => $backup_id ? 'To undo: apply backup_post_id onto the target the same way.' : null,
		);
	}

	// ------------------------------------------------------------------
	// Preview links (draft posts and not-yet-active themes, no login needed)
	// ------------------------------------------------------------------

	const PREVIEW_PREFIX = 'cbmcp_prev_';

	private static function make_preview( array $data, $minutes ) {
		$token = bin2hex( random_bytes( 16 ) );
		set_transient( self::PREVIEW_PREFIX . $token, $data, $minutes * 60 );
		$url = ! empty( $data['post_id'] ) ? get_permalink( (int) $data['post_id'] ) : home_url( '/' );
		return array(
			'url'                => add_query_arg( 'cbmcp_preview', $token, $url ),
			'token'              => $token,
			'expires_in_minutes' => $minutes,
		);
	}

	public static function route_preview_create( WP_REST_Request $req ) {
		$data = array();
		if ( $req->get_param( 'theme' ) ) {
			$theme = wp_get_theme( (string) $req->get_param( 'theme' ) );
			if ( ! $theme->exists() ) {
				return self::err( 'cbmcp_no_theme', 'Theme not found.', 404 );
			}
			$data['stylesheet'] = $theme->get_stylesheet();
			$data['template']   = $theme->get_template();
		}
		if ( $req->get_param( 'post_id' ) ) {
			$post = get_post( (int) $req->get_param( 'post_id' ) );
			if ( ! $post ) {
				return self::err( 'cbmcp_not_found', 'Post not found.', 404 );
			}
			$data['post_id'] = $post->ID;
		}
		if ( ! $data ) {
			return self::err( 'cbmcp_preview_empty', 'Give theme and/or post_id.' );
		}
		$minutes = (int) $req->get_param( 'minutes' );
		$minutes = $minutes > 0 ? min( 1440 * 7, $minutes ) : 120;
		$p       = self::make_preview( $data, $minutes );
		$p['note'] = 'Anyone with this link can view the preview until it expires. Page caching is disabled for preview requests.';
		return $p;
	}

	/** Applies a preview token from ?cbmcp_preview= (or its cookie) to front-end requests. */
	public static function maybe_preview() {
		if ( is_admin() || wp_doing_ajax() || wp_doing_cron() ) {
			return;
		}
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : ''; // phpcs:ignore
		if ( false !== strpos( $uri, '/wp-json/' ) || false !== strpos( $uri, 'rest_route=' ) || false !== strpos( $uri, 'wp-login.php' ) ) {
			return;
		}
		$from_get = isset( $_GET['cbmcp_preview'] ); // phpcs:ignore
		$token    = $from_get ? (string) $_GET['cbmcp_preview'] : ( isset( $_COOKIE['cbmcp_preview'] ) ? (string) $_COOKIE['cbmcp_preview'] : '' ); // phpcs:ignore
		if ( ! preg_match( '/^[a-f0-9]{32}$/', $token ) ) {
			return;
		}
		$data = get_transient( self::PREVIEW_PREFIX . $token );
		if ( ! is_array( $data ) ) {
			return;
		}
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		add_action(
			'send_headers',
			function () {
				nocache_headers();
				header( 'X-Robots-Tag: noindex, nofollow' );
			}
		);
		if ( ! empty( $data['stylesheet'] ) ) {
			$ss = $data['stylesheet'];
			$tp = $data['template'];
			if ( $from_get && ! headers_sent() ) {
				setcookie( 'cbmcp_preview', $token, 0, COOKIEPATH ? COOKIEPATH : '/', COOKIE_DOMAIN, is_ssl(), true );
			}
			$fs = function () use ( $ss ) {
				return $ss;
			};
			$ft = function () use ( $tp ) {
				return $tp;
			};
			add_filter( 'stylesheet', $fs, 99 );
			add_filter( 'template', $ft, 99 );
			add_filter( 'pre_option_stylesheet', $fs, 99 );
			add_filter( 'pre_option_template', $ft, 99 );
		}
		if ( ! empty( $data['post_id'] ) ) {
			$pid = (int) $data['post_id'];
			add_filter(
				'posts_results',
				function ( $posts, $query ) use ( $pid ) {
					if ( $query->is_main_query() && 1 === count( $posts ) && (int) $posts[0]->ID === $pid && 'publish' !== $posts[0]->post_status && 'trash' !== $posts[0]->post_status ) {
						$posts[0]->post_status = 'publish';
					}
					return $posts;
				},
				10,
				2
			);
		}
	}

	// ------------------------------------------------------------------
	// Draft themes
	// ------------------------------------------------------------------

	private static function copy_dir( $src, $dst ) {
		if ( ! wp_mkdir_p( $dst ) ) {
			return false;
		}
		foreach ( (array) scandir( $src ) as $f ) {
			if ( '.' === $f || '..' === $f || in_array( $f, array( '.git', 'node_modules', '.svn' ), true ) ) {
				continue;
			}
			$s = $src . '/' . $f;
			$d = $dst . '/' . $f;
			if ( is_link( $s ) ) {
				continue;
			}
			if ( is_dir( $s ) ) {
				if ( ! self::copy_dir( $s, $d ) ) {
					return false;
				}
			} elseif ( ! @copy( $s, $d ) ) { // phpcs:ignore
				return false;
			}
		}
		return true;
	}

	private static function set_theme_header( $style_css, $field, $value ) {
		$css = (string) @file_get_contents( $style_css ); // phpcs:ignore
		$pattern = '/^([ \t\/*#@]*' . preg_quote( $field, '/' ) . ':)(.*)$/mi';
		if ( preg_match( $pattern, $css ) ) {
			$css = preg_replace( $pattern, '$1 ' . str_replace( array( '\\', '$' ), array( '\\\\', '\\$' ), $value ), $css, 1 );
		} else {
			$css = preg_replace( '~/\*~', "/*\n" . $field . ': ' . $value, $css, 1 );
		}
		@file_put_contents( $style_css, $css ); // phpcs:ignore
	}

	public static function route_theme_copy( WP_REST_Request $req ) {
		if ( ! self::file_write_enabled() ) {
			return self::err( 'cbmcp_write_disabled', 'File writing is disabled (CBMCP_DISABLE_FILE_WRITE).', 403 );
		}
		$from = wp_get_theme( (string) $req->get_param( 'from' ) );
		$slug = (string) $req->get_param( 'slug' );
		if ( ! $from->exists() ) {
			return self::err( 'cbmcp_no_theme', 'Source theme not found.', 404 );
		}
		if ( ! preg_match( '/^[a-z0-9][a-z0-9-]{0,60}$/', $slug ) ) {
			return self::err( 'cbmcp_bad_slug', 'slug: lowercase letters, numbers and "-".' );
		}
		$dst = get_theme_root() . '/' . $slug;
		if ( file_exists( $dst ) ) {
			return self::err( 'cbmcp_exists', 'A theme with this slug already exists.', 409 );
		}
		if ( ! self::copy_dir( $from->get_stylesheet_directory(), $dst ) ) {
			return self::err( 'cbmcp_copy_failed', 'Could not copy theme files.', 500 );
		}
		$name = $req->get_param( 'name' ) ? (string) $req->get_param( 'name' ) : $from->get( 'Name' ) . ' (Draft)';
		if ( is_file( $dst . '/style.css' ) ) {
			self::set_theme_header( $dst . '/style.css', 'Theme Name', $name );
		}
		wp_clean_themes_cache();
		$preview = self::make_preview(
			array(
				'stylesheet' => $slug,
				'template'   => $from->get_template() === $from->get_stylesheet() ? $slug : $from->get_template(),
			),
			240
		);
		return array(
			'stylesheet'  => $slug,
			'name'        => $name,
			'path'        => 'themes/' . $slug,
			'preview_url' => $preview['url'],
			'note'        => 'Not active. Edit with file tools under themes/' . $slug . ', review via preview_url, activate only on request.',
		);
	}

	public static function route_theme_child( WP_REST_Request $req ) {
		if ( ! self::file_write_enabled() ) {
			return self::err( 'cbmcp_write_disabled', 'File writing is disabled (CBMCP_DISABLE_FILE_WRITE).', 403 );
		}
		$parent = wp_get_theme( (string) $req->get_param( 'parent' ) );
		if ( ! $parent->exists() ) {
			return self::err( 'cbmcp_no_theme', 'Parent theme not found.', 404 );
		}
		if ( $parent->parent() ) {
			return self::err( 'cbmcp_is_child', 'The parent must not be a child theme itself.' );
		}
		$slug = $req->get_param( 'slug' ) ? (string) $req->get_param( 'slug' ) : $parent->get_stylesheet() . '-child';
		if ( ! preg_match( '/^[a-z0-9][a-z0-9-]{0,60}$/', $slug ) ) {
			return self::err( 'cbmcp_bad_slug', 'slug: lowercase letters, numbers and "-".' );
		}
		$dst = get_theme_root() . '/' . $slug;
		if ( file_exists( $dst ) ) {
			return self::err( 'cbmcp_exists', 'A theme with this slug already exists.', 409 );
		}
		$name   = $req->get_param( 'name' ) ? (string) $req->get_param( 'name' ) : $parent->get( 'Name' ) . ' Child';
		$author = $req->get_param( 'author' ) ? (string) $req->get_param( 'author' ) : 'Code & Blocks by Marijan';
		$block  = method_exists( $parent, 'is_block_theme' ) && $parent->is_block_theme();
		wp_mkdir_p( $dst );
		$clean = function ( $v ) {
			return str_replace( array( '*/', "\n", "\r" ), '', $v );
		};
		$css = "/*\nTheme Name: " . $clean( $name ) . "\nTemplate: " . $parent->get_stylesheet() . "\nAuthor: " . $clean( $author ) . "\nDescription: Child theme of " . $clean( $parent->get( 'Name' ) ) . "\nVersion: 1.0.0\nText Domain: $slug\n*/\n";
		file_put_contents( $dst . '/style.css', $css ); // phpcs:ignore
		if ( $block ) {
			$php = "<?php\n/**\n * " . $clean( $name ) . " – functions.\n * Author: " . $clean( $author ) . "\n */\n\nif ( ! defined( 'ABSPATH' ) ) {\n\texit;\n}\n\nadd_action( 'wp_enqueue_scripts', function () {\n\twp_enqueue_style( '$slug-style', get_stylesheet_uri(), array(), wp_get_theme()->get( 'Version' ) );\n} );\n";
			file_put_contents( $dst . '/theme.json', wp_json_encode( array( '$schema' => 'https://schemas.wp.org/trunk/theme.json', 'version' => 3 ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" ); // phpcs:ignore
		} else {
			$php = "<?php\n/**\n * " . $clean( $name ) . " – functions.\n * Author: " . $clean( $author ) . "\n */\n\nif ( ! defined( 'ABSPATH' ) ) {\n\texit;\n}\n\nadd_action( 'wp_enqueue_scripts', function () {\n\twp_enqueue_style( 'parent-style', get_template_directory_uri() . '/style.css', array(), wp_get_theme( get_template() )->get( 'Version' ) );\n\twp_enqueue_style( '$slug-style', get_stylesheet_uri(), array( 'parent-style' ), wp_get_theme()->get( 'Version' ) );\n} );\n";
		}
		file_put_contents( $dst . '/functions.php', $php ); // phpcs:ignore
		if ( is_file( $parent->get_stylesheet_directory() . '/screenshot.png' ) ) {
			@copy( $parent->get_stylesheet_directory() . '/screenshot.png', $dst . '/screenshot.png' ); // phpcs:ignore
		}
		wp_clean_themes_cache();
		$preview = self::make_preview(
			array(
				'stylesheet' => $slug,
				'template'   => $parent->get_stylesheet(),
			),
			240
		);
		return array(
			'stylesheet'  => $slug,
			'parent'      => $parent->get_stylesheet(),
			'block_theme' => $block,
			'path'        => 'themes/' . $slug,
			'preview_url' => $preview['url'],
		);
	}
}

CBMCP_Bridge::init();
