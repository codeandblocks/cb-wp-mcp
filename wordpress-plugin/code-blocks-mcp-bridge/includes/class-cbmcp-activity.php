<?php
/**
 * Code & Blocks MCP Bridge – activity log and live notices in wp-admin.
 *
 * The MCP server reports every change it makes (POST cbmcp/v1/activity/log).
 * Entries are shown on the plugin page, as admin-bar counter and as live
 * toasts via the WordPress Heartbeat API.
 *
 * @package CodeBlocksMcpBridge
 * Author: Code & Blocks by Marijan
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CBMCP_Activity {

	const DB_VERSION = '1';
	const KEEP       = 2000;
	const SEEN_META  = 'cbmcp_activity_seen';

	public static function init() {
		add_action( 'plugins_loaded', array( __CLASS__, 'maybe_install' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_filter( 'heartbeat_received', array( __CLASS__, 'heartbeat' ), 10, 2 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 90 );
	}

	public static function table() {
		global $wpdb;
		return $wpdb->prefix . 'cbmcp_activity';
	}

	public static function maybe_install() {
		if ( get_option( 'cbmcp_activity_db' ) === self::DB_VERSION ) {
			return;
		}
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$charset = $wpdb->get_charset_collate();
		$table   = self::table();
		dbDelta(
			"CREATE TABLE $table (
				id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
				created datetime NOT NULL,
				kind varchar(20) NOT NULL DEFAULT 'change',
				tool varchar(64) NOT NULL DEFAULT '',
				summary text NOT NULL,
				status varchar(20) NOT NULL DEFAULT 'ok',
				object_type varchar(40) NOT NULL DEFAULT '',
				object_id bigint(20) unsigned NOT NULL DEFAULT 0,
				link text NULL,
				edit_link text NULL,
				user_login varchar(60) NOT NULL DEFAULT '',
				PRIMARY KEY  (id),
				KEY created (created)
			) $charset;"
		);
		update_option( 'cbmcp_activity_db', self::DB_VERSION, true );
	}

	public static function log( array $e ) {
		global $wpdb;
		$user = wp_get_current_user();
		$wpdb->insert(
			self::table(),
			array(
				'created'     => current_time( 'mysql', true ),
				'kind'        => substr( sanitize_key( $e['kind'] ?? 'change' ), 0, 20 ),
				'tool'        => substr( sanitize_key( $e['tool'] ?? '' ), 0, 64 ),
				'summary'     => mb_substr( wp_strip_all_tags( (string) ( $e['summary'] ?? '' ) ), 0, 500 ),
				'status'      => substr( sanitize_key( $e['status'] ?? 'ok' ), 0, 20 ),
				'object_type' => substr( sanitize_key( $e['object_type'] ?? '' ), 0, 40 ),
				'object_id'   => absint( $e['object_id'] ?? 0 ),
				'link'        => esc_url_raw( (string) ( $e['link'] ?? '' ) ),
				'edit_link'   => esc_url_raw( (string) ( $e['edit_link'] ?? '' ) ),
				'user_login'  => $user && $user->exists() ? $user->user_login : '',
			)
		);
		$id = (int) $wpdb->insert_id;
		if ( $id && 0 === $id % 50 ) {
			$table = self::table();
			$wpdb->query( $wpdb->prepare( "DELETE FROM $table WHERE id <= %d", $id - self::KEEP ) ); // phpcs:ignore
		}
		return $id;
	}

	public static function recent( $limit = 50, $since_id = 0 ) {
		global $wpdb;
		$table = self::table();
		return $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM $table WHERE id > %d ORDER BY id DESC LIMIT %d", (int) $since_id, (int) $limit ), // phpcs:ignore
			ARRAY_A
		);
	}

	public static function last_id() {
		global $wpdb;
		$table = self::table();
		return (int) $wpdb->get_var( "SELECT MAX(id) FROM $table" ); // phpcs:ignore
	}

	public static function unseen_count( $user_id ) {
		global $wpdb;
		$table = self::table();
		$seen  = (int) get_user_meta( $user_id, self::SEEN_META, true );
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM $table WHERE id > %d", $seen ) ); // phpcs:ignore
	}

	public static function mark_seen( $user_id ) {
		update_user_meta( $user_id, self::SEEN_META, self::last_id() );
	}

	// ---- REST ----

	public static function routes() {
		register_rest_route(
			'cbmcp/v1',
			'/activity/log',
			array(
				'methods'             => 'POST',
				'callback'            => function ( WP_REST_Request $req ) {
					$id = CBMCP_Activity::log( (array) $req->get_json_params() );
					return array( 'logged' => $id );
				},
				'permission_callback' => array( 'CBMCP_Bridge', 'can_manage' ),
			)
		);
		register_rest_route(
			'cbmcp/v1',
			'/activity',
			array(
				'methods'             => 'GET',
				'callback'            => function ( WP_REST_Request $req ) {
					$limit = max( 1, min( 200, (int) ( $req->get_param( 'limit' ) ? $req->get_param( 'limit' ) : 50 ) ) );
					return CBMCP_Activity::recent( $limit, (int) $req->get_param( 'since_id' ) );
				},
				'permission_callback' => array( 'CBMCP_Bridge', 'can_manage' ),
			)
		);
	}

	// ---- Live notices ----

	private static function wants_notices() {
		return is_user_logged_in() && current_user_can( 'manage_options' ) && CBMCP_Settings::enabled( 'notices' );
	}

	public static function enqueue() {
		if ( ! self::wants_notices() || ( ! is_admin() && ! is_admin_bar_showing() ) ) {
			return;
		}
		$base = plugin_dir_url( CBMCP_FILE );
		wp_enqueue_script( 'cbmcp-live', $base . 'assets/live.js', array( 'heartbeat' ), CBMCP_VERSION, true );
		wp_enqueue_style( 'cbmcp-live', $base . 'assets/live.css', array(), CBMCP_VERSION );
		wp_localize_script(
			'cbmcp-live',
			'cbmcpLive',
			array(
				'since'    => self::last_id(),
				'activity' => admin_url( 'admin.php?page=cbmcp&tab=activity' ),
				'i18n'     => array(
					'title'    => __( 'Claude', 'cb-mcp-bridge' ),
					'view'     => __( 'Ansehen', 'cb-mcp-bridge' ),
					'edit'     => __( 'Bearbeiten', 'cb-mcp-bridge' ),
					'approve'  => __( 'Freigabe öffnen', 'cb-mcp-bridge' ),
					'all'      => __( 'Alle Aktivitäten', 'cb-mcp-bridge' ),
					'dismiss'  => __( 'Schließen', 'cb-mcp-bridge' ),
				),
			)
		);
	}

	public static function heartbeat( $response, $data ) {
		if ( ! isset( $data['cbmcp_since'] ) || ! self::wants_notices() ) {
			return $response;
		}
		$rows = array_reverse( self::recent( 5, (int) $data['cbmcp_since'] ) );
		$response['cbmcp'] = array_map(
			function ( $r ) {
				return array(
					'id'        => (int) $r['id'],
					'kind'      => $r['kind'],
					'status'    => $r['status'],
					'summary'   => $r['summary'],
					'link'      => $r['link'],
					'edit_link' => $r['edit_link'],
				);
			},
			$rows
		);
		return $response;
	}

	public static function admin_bar( WP_Admin_Bar $bar ) {
		if ( ! self::wants_notices() ) {
			return;
		}
		$n = self::unseen_count( get_current_user_id() );
		$bar->add_node(
			array(
				'id'    => 'cbmcp-activity',
				'title' => '<span class="ab-icon dashicons dashicons-superhero-alt" style="top:2px"></span><span class="ab-label">Claude' . ( $n ? ' <span class="cbmcp-count">' . (int) $n . '</span>' : '' ) . '</span>',
				'href'  => admin_url( 'admin.php?page=cbmcp&tab=activity' ),
				'meta'  => array( 'title' => sprintf( /* translators: %d: number */ __( '%d neue Änderungen durch Claude', 'cb-mcp-bridge' ), $n ) ),
			)
		);
	}
}
