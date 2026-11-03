<?php
/**
 * Code & Blocks MCP Bridge – plugin, theme and core updates.
 *
 * @package CodeBlocksMcpBridge
 * Author: Code & Blocks by Marijan
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CBMCP_Updates {

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
	}

	public static function routes() {
		register_rest_route(
			'cbmcp/v1',
			'/updates/list',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'route_list' ),
				'permission_callback' => array( 'CBMCP_Bridge', 'can_manage' ),
			)
		);
		register_rest_route(
			'cbmcp/v1',
			'/updates/run',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'route_run' ),
				'permission_callback' => function () {
					return current_user_can( 'update_plugins' ) || current_user_can( 'update_themes' ) || current_user_can( 'update_core' );
				},
			)
		);
	}

	private static function load() {
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/misc.php';
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		require_once ABSPATH . 'wp-admin/includes/theme.php';
		require_once ABSPATH . 'wp-admin/includes/update.php';
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
	}

	public static function collect( $refresh ) {
		self::load();
		if ( $refresh ) {
			wp_clean_plugins_cache( true );
			wp_update_plugins();
			wp_update_themes();
			wp_version_check( array(), true );
		}
		$plugins = array();
		foreach ( get_plugin_updates() as $file => $p ) {
			$plugins[] = array(
				'plugin'      => $file,
				'name'        => $p->Name,
				'version'     => $p->Version,
				'new_version' => $p->update->new_version ?? null,
				'active'      => is_plugin_active( $file ),
			);
		}
		$themes = array();
		foreach ( get_theme_updates() as $stylesheet => $t ) {
			$themes[] = array(
				'theme'       => $stylesheet,
				'name'        => $t->get( 'Name' ),
				'version'     => $t->get( 'Version' ),
				'new_version' => $t->update['new_version'] ?? null,
				'active'      => get_stylesheet() === $stylesheet || get_template() === $stylesheet,
			);
		}
		global $wp_version;
		$core_new = null;
		foreach ( (array) get_core_updates() as $offer ) {
			if ( isset( $offer->response ) && 'upgrade' === $offer->response ) {
				$core_new = $offer->current;
				break;
			}
		}
		return array(
			'core'        => array(
				'version'     => $wp_version,
				'new_version' => $core_new,
			),
			'plugins'     => $plugins,
			'themes'      => $themes,
			'fs_method'   => get_filesystem_method(),
			'can_update'  => 'direct' === get_filesystem_method(),
			'checked_utc' => gmdate( 'c' ),
		);
	}

	public static function route_list( WP_REST_Request $req ) {
		return self::collect( filter_var( $req->get_param( 'refresh' ), FILTER_VALIDATE_BOOLEAN ) );
	}

	public static function route_run( WP_REST_Request $req ) {
		$type  = sanitize_key( (string) $req->get_param( 'type' ) );
		$items = array_values( array_filter( array_map( 'strval', (array) $req->get_param( 'items' ) ) ) );
		self::load();
		if ( 'direct' !== get_filesystem_method() ) {
			return new WP_Error( 'cbmcp_fs', 'WordPress cannot write files directly (FS_METHOD is not "direct"); updates need FTP credentials and must be run in wp-admin.', array( 'status' => 409 ) );
		}
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 600 ); // phpcs:ignore
		}
		$skin = new WP_Ajax_Upgrader_Skin();

		if ( 'plugin' === $type ) {
			if ( ! current_user_can( 'update_plugins' ) ) {
				return new WP_Error( 'cbmcp_cap', 'Missing capability update_plugins.', array( 'status' => 403 ) );
			}
			$available = wp_list_pluck( self::collect( false )['plugins'], 'plugin' );
			$items     = $items ? array_values( array_intersect( $items, $available ) ) : $available;
			$before    = get_plugins();
			$upgrader  = new Plugin_Upgrader( $skin );
			$result    = $items ? $upgrader->bulk_upgrade( $items ) : array();
			wp_clean_plugins_cache( true );
			$after = get_plugins();
			$out   = array();
			foreach ( $items as $f ) {
				$out[] = array(
					'plugin' => $f,
					'from'   => $before[ $f ]['Version'] ?? null,
					'to'     => $after[ $f ]['Version'] ?? null,
					'ok'     => ( isset( $result[ $f ] ) && true === $result[ $f ] ) || ( ( $after[ $f ]['Version'] ?? '' ) !== ( $before[ $f ]['Version'] ?? '' ) ),
				);
			}
			return array(
				'type'    => 'plugin',
				'results' => $out,
				'errors'  => $skin->get_error_messages(),
			);
		}

		if ( 'theme' === $type ) {
			if ( ! current_user_can( 'update_themes' ) ) {
				return new WP_Error( 'cbmcp_cap', 'Missing capability update_themes.', array( 'status' => 403 ) );
			}
			$available = wp_list_pluck( self::collect( false )['themes'], 'theme' );
			$items     = $items ? array_values( array_intersect( $items, $available ) ) : $available;
			$before    = array();
			foreach ( $items as $s ) {
				$before[ $s ] = wp_get_theme( $s )->get( 'Version' );
			}
			$upgrader = new Theme_Upgrader( $skin );
			$result   = $items ? $upgrader->bulk_upgrade( $items ) : array();
			wp_clean_themes_cache();
			$out = array();
			foreach ( $items as $s ) {
				$to    = wp_get_theme( $s )->get( 'Version' );
				$out[] = array(
					'theme' => $s,
					'from'  => $before[ $s ],
					'to'    => $to,
					'ok'    => $to !== $before[ $s ],
				);
			}
			return array(
				'type'    => 'theme',
				'results' => $out,
				'errors'  => $skin->get_error_messages(),
			);
		}

		if ( 'core' === $type ) {
			if ( ! current_user_can( 'update_core' ) ) {
				return new WP_Error( 'cbmcp_cap', 'Missing capability update_core.', array( 'status' => 403 ) );
			}
			global $wp_version;
			$from  = $wp_version;
			$offer = null;
			foreach ( (array) get_core_updates() as $o ) {
				if ( isset( $o->response ) && 'upgrade' === $o->response ) {
					$offer = $o;
					break;
				}
			}
			if ( ! $offer ) {
				return array(
					'type'    => 'core',
					'results' => array(),
					'note'    => 'WordPress is up to date.',
				);
			}
			$upgrader = new Core_Upgrader( $skin );
			$result   = $upgrader->upgrade( $offer );
			if ( is_wp_error( $result ) ) {
				return $result;
			}
			return array(
				'type'    => 'core',
				'results' => array(
					array(
						'from' => $from,
						'to'   => $result,
						'ok'   => true,
					),
				),
				'errors'  => $skin->get_error_messages(),
			);
		}

		return new WP_Error( 'cbmcp_type', 'type must be plugin, theme or core.', array( 'status' => 400 ) );
	}
}
