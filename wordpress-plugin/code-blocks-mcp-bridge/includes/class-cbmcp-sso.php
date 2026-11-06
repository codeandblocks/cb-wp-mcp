<?php
/**
 * Code & Blocks MCP Bridge – login with WordPress for the MCP server portal and AI clients.
 *
 * 1. The server redirects the browser to admin-post.php?action=cbmcp_sso&state=…
 * 2. A logged-in administrator gets a one-time code (2 minutes) and is sent
 *    back – only to the server address saved in this plugin.
 * 3. The server redeems the code over its authenticated REST connection
 *    (POST cbmcp/v1/sso/verify). Codes are stored hashed and work once.
 *
 * @package CodeBlocksMcpBridge
 * Author: Code & Blocks by Marijan
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CBMCP_SSO {

	const PREFIX = 'cbmcp_sso_';
	const TTL    = 120;

	public static function init() {
		add_action( 'admin_post_cbmcp_sso', array( __CLASS__, 'start' ) );
		add_action( 'admin_post_nopriv_cbmcp_sso', array( __CLASS__, 'login_first' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
	}

	public static function login_first() {
		auth_redirect(); // sends the visitor to wp-login.php and back here
		exit;
	}

	public static function start() {
		$server = CBMCP_Settings::get( 'server_url' );
		$state  = isset( $_GET['state'] ) ? (string) wp_unslash( $_GET['state'] ) : ''; // phpcs:ignore
		if ( ! $server ) {
			wp_die( esc_html__( 'In „Code & Blocks MCP → Verbindung“ ist noch kein MCP-Server eingetragen.', 'cb-mcp-bridge' ), 400 );
		}
		if ( ! preg_match( '/^[A-Za-z0-9_-]{20,128}$/', $state ) ) {
			wp_die( esc_html__( 'Ungültige Anmeldeanfrage.', 'cb-mcp-bridge' ), 400 );
		}
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Nur Administratoren können sich am MCP-Portal anmelden.', 'cb-mcp-bridge' ), 403 );
		}
		$user = wp_get_current_user();
		$code = wp_generate_password( 48, false, false );
		set_transient(
			self::PREFIX . hash( 'sha256', $code ),
			array(
				'user_id' => $user->ID,
				'state'   => $state,
			),
			self::TTL
		);
		$target = add_query_arg(
			array(
				'state' => rawurlencode( $state ),
				'code'  => rawurlencode( $code ),
			),
			untrailingslashit( $server ) . '/sso/callback'
		);
		nocache_headers();
		header( 'Referrer-Policy: no-referrer' );
		wp_redirect( $target ); // phpcs:ignore WordPress.Security.SafeRedirect -- only the configured server URL
		exit;
	}

	public static function routes() {
		register_rest_route(
			'cbmcp/v1',
			'/sso/verify',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'verify' ),
				'permission_callback' => array( 'CBMCP_Bridge', 'can_manage' ),
			)
		);
	}

	public static function verify( WP_REST_Request $req ) {
		$code = (string) $req->get_param( 'code' );
		if ( ! preg_match( '/^[A-Za-z0-9_-]{20,128}$/', $code ) ) {
			return new WP_Error( 'cbmcp_sso_invalid', 'Invalid code.', array( 'status' => 400 ) );
		}
		$key  = self::PREFIX . hash( 'sha256', $code );
		$data = get_transient( $key );
		delete_transient( $key );
		if ( ! is_array( $data ) ) {
			return new WP_Error( 'cbmcp_sso_expired', 'Code expired or already used.', array( 'status' => 400 ) );
		}
		$user = get_userdata( (int) $data['user_id'] );
		if ( ! $user ) {
			return new WP_Error( 'cbmcp_sso_user', 'User not found.', array( 'status' => 400 ) );
		}
		return array(
			'user_login'     => $user->user_login,
			'display_name'   => $user->display_name,
			'state'          => $data['state'],
			'manage_options' => user_can( $user, 'manage_options' ),
		);
	}
}
