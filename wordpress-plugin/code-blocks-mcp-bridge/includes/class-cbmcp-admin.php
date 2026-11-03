<?php
/**
 * Code & Blocks MCP Bridge – admin page (connection, security, activity, snippets, backups).
 *
 * @package CodeBlocksMcpBridge
 * Author: Code & Blocks by Marijan
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CBMCP_Admin {

	const APP_NAME = 'Code & Blocks MCP';
	const APP_ID   = '6f1c3c2e-6c2b-4e43-9d8f-2a9c0b5d7e11';
	const SLUG     = 'cbmcp';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_cbmcp_save_settings', array( __CLASS__, 'save_settings' ) );
		add_action( 'admin_post_cbmcp_disconnect', array( __CLASS__, 'disconnect' ) );
		add_action( 'admin_post_cbmcp_snippet', array( __CLASS__, 'snippet_action' ) );
		add_action( 'admin_post_cbmcp_restore', array( __CLASS__, 'restore_backup' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( CBMCP_FILE ), array( __CLASS__, 'action_links' ) );
	}

	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Einstellungen', 'cb-mcp-bridge' ) . '</a>' );
		return $links;
	}

	public static function url( $tab = '', $args = array() ) {
		$args = array_merge( array( 'page' => self::SLUG ), $tab ? array( 'tab' => $tab ) : array(), $args );
		return add_query_arg( $args, admin_url( 'admin.php' ) );
	}

	public static function menu() {
		$hook = add_menu_page(
			'Code & Blocks MCP',
			'Code & Blocks MCP',
			'manage_options',
			self::SLUG,
			array( __CLASS__, 'render' ),
			'dashicons-superhero-alt',
			81
		);
		add_action(
			'admin_print_styles-' . $hook,
			function () {
				wp_enqueue_style( 'cbmcp-admin', plugin_dir_url( CBMCP_FILE ) . 'assets/admin.css', array(), CBMCP_VERSION );
			}
		);
	}

	private static function back( $tab, $msg, $type = 'success' ) {
		wp_safe_redirect(
			self::url(
				$tab,
				array(
					'cbmcp_msg'  => rawurlencode( $msg ),
					'cbmcp_type' => $type,
				)
			)
		);
		exit;
	}

	private static function check( $action ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Keine Berechtigung.', 'cb-mcp-bridge' ), 403 );
		}
		check_admin_referer( $action );
	}

	/** Application passwords created through the MCP connect flow, for all admins. */
	public static function connections() {
		if ( ! class_exists( 'WP_Application_Passwords' ) ) {
			return array();
		}
		$out   = array();
		$users = get_users(
			array(
				'capability' => 'manage_options',
				'fields'     => array( 'ID', 'user_login' ),
			)
		);
		foreach ( $users as $u ) {
			foreach ( WP_Application_Passwords::get_user_application_passwords( $u->ID ) as $p ) {
				if ( ( $p['app_id'] ?? '' ) === self::APP_ID || self::APP_NAME === $p['name'] ) {
					$out[] = array_merge( $p, array( 'user_login' => $u->user_login, 'user_id' => $u->ID ) );
				}
			}
		}
		return $out;
	}

	// ------------------------------------------------------------------
	// Actions
	// ------------------------------------------------------------------

	public static function save_settings() {
		self::check( 'cbmcp_save_settings' );
		$tab = isset( $_POST['tab'] ) ? sanitize_key( $_POST['tab'] ) : 'connection'; // phpcs:ignore
		$values = array();
		if ( 'connection' === $tab ) {
			$url = isset( $_POST['server_url'] ) ? esc_url_raw( trim( wp_unslash( $_POST['server_url'] ) ) ) : ''; // phpcs:ignore
			if ( $url && 'https' !== wp_parse_url( $url, PHP_URL_SCHEME ) ) {
				self::back( $tab, __( 'Die Server-Adresse muss mit https:// beginnen.', 'cb-mcp-bridge' ), 'error' );
			}
			$values['server_url'] = untrailingslashit( $url );
		} else {
			foreach ( array( 'file_write', 'snippets', 'db_write', 'safe_mode', 'notices' ) as $k ) {
				$values[ $k ] = ! empty( $_POST[ $k ] ); // phpcs:ignore
			}
		}
		CBMCP_Settings::update( $values );
		self::back( $tab, __( 'Gespeichert.', 'cb-mcp-bridge' ) );
	}

	public static function disconnect() {
		self::check( 'cbmcp_disconnect' );
		$n = 0;
		foreach ( self::connections() as $c ) {
			if ( WP_Application_Passwords::delete_application_password( $c['user_id'], $c['uuid'] ) === true ) {
				$n++;
			}
		}
		/* translators: %d: number of revoked passwords */
		self::back( 'connection', sprintf( __( 'Verbindung getrennt (%d Anwendungspasswort(e) widerrufen).', 'cb-mcp-bridge' ), $n ) );
	}

	public static function snippet_action() {
		self::check( 'cbmcp_snippet' );
		$name = isset( $_POST['name'] ) ? sanitize_key( wp_unslash( $_POST['name'] ) ) : ''; // phpcs:ignore
		$do   = isset( $_POST['do'] ) ? sanitize_key( $_POST['do'] ) : ''; // phpcs:ignore
		$req  = new WP_REST_Request( 'POST' );
		$req->set_param( 'name', $name );
		if ( 'delete' === $do ) {
			$res = CBMCP_Bridge::route_snippets_delete( $req );
		} else {
			$req->set_param( 'active', 'enable' === $do );
			$res = CBMCP_Bridge::route_snippets_toggle( $req );
		}
		if ( is_wp_error( $res ) ) {
			self::back( 'snippets', $res->get_error_message(), 'error' );
		}
		CBMCP_Activity::log(
			array(
				'tool'    => 'manage_snippet',
				'summary' => sprintf( 'Snippet "%s": %s (wp-admin)', $name, $do ),
			)
		);
		self::back( 'snippets', __( 'Snippet aktualisiert.', 'cb-mcp-bridge' ) );
	}

	public static function restore_backup() {
		self::check( 'cbmcp_restore' );
		$name = isset( $_POST['backup'] ) ? basename( sanitize_file_name( wp_unslash( $_POST['backup'] ) ) ) : ''; // phpcs:ignore
		$res  = CBMCP_Bridge::restore_by_backup_name( $name );
		if ( is_wp_error( $res ) ) {
			self::back( 'backups', $res->get_error_message(), 'error' );
		}
		CBMCP_Activity::log(
			array(
				'tool'    => 'restore',
				'summary' => 'Backup wiederhergestellt: ' . $name . ' (wp-admin)',
			)
		);
		self::back( 'backups', __( 'Backup wiederhergestellt. Vom vorherigen Stand wurde ein neues Backup angelegt.', 'cb-mcp-bridge' ) );
	}

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( $_GET['tab'] ) : 'connection'; // phpcs:ignore
		$tabs = array(
			'connection' => __( 'Verbindung', 'cb-mcp-bridge' ),
			'security'   => __( 'Sicherheit', 'cb-mcp-bridge' ),
			'activity'   => __( 'Aktivität', 'cb-mcp-bridge' ),
			'snippets'   => __( 'Snippets', 'cb-mcp-bridge' ),
			'backups'    => __( 'Backups', 'cb-mcp-bridge' ),
		);
		if ( ! isset( $tabs[ $tab ] ) ) {
			$tab = 'connection';
		}
		echo '<div class="wrap cbmcp">';
		echo '<h1 class="cbmcp-title"><span class="dashicons dashicons-superhero-alt"></span> Code &amp; Blocks MCP <span class="cbmcp-version">' . esc_html( CBMCP_VERSION ) . '</span></h1>';

		if ( isset( $_GET['cbmcp_msg'] ) ) { // phpcs:ignore
			$type = ( isset( $_GET['cbmcp_type'] ) && 'error' === $_GET['cbmcp_type'] ) ? 'error' : 'success'; // phpcs:ignore
			echo '<div class="notice notice-' . esc_attr( $type ) . ' is-dismissible"><p>' . esc_html( rawurldecode( wp_unslash( $_GET['cbmcp_msg'] ) ) ) . '</p></div>'; // phpcs:ignore
		}
		if ( isset( $_GET['cbmcp_connected'] ) ) { // phpcs:ignore
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__( 'Verbunden. Claude kann jetzt über deinen MCP-Server auf diese Seite zugreifen.', 'cb-mcp-bridge' ) . '</p></div>';
		}

		echo '<nav class="nav-tab-wrapper">';
		foreach ( $tabs as $k => $label ) {
			echo '<a href="' . esc_url( self::url( $k ) ) . '" class="nav-tab' . ( $k === $tab ? ' nav-tab-active' : '' ) . '">' . esc_html( $label ) . '</a>';
		}
		echo '</nav><div class="cbmcp-body">';
		call_user_func( array( __CLASS__, 'tab_' . $tab ) );
		echo '</div><p class="cbmcp-footer">Code &amp; Blocks by Marijan</p></div>';
	}

	private static function fmt_time( $ts ) {
		if ( ! $ts ) {
			return '–';
		}
		return esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), (int) $ts ) );
	}

	private static function tab_connection() {
		$server = CBMCP_Settings::get( 'server_url' );
		$conns  = self::connections();
		$avail  = function_exists( 'wp_is_application_passwords_available' ) ? wp_is_application_passwords_available() : false;

		echo '<div class="cbmcp-card">';
		echo '<h2>' . esc_html__( 'Status', 'cb-mcp-bridge' ) . '</h2>';
		if ( $conns ) {
			echo '<p class="cbmcp-status ok"><span class="dashicons dashicons-yes-alt"></span> ' . esc_html__( 'Verbunden', 'cb-mcp-bridge' ) . '</p>';
			echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Benutzer', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Erstellt', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Zuletzt benutzt', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Letzte IP', 'cb-mcp-bridge' ) . '</th></tr></thead><tbody>';
			foreach ( $conns as $c ) {
				echo '<tr><td>' . esc_html( $c['user_login'] ) . '</td><td>' . self::fmt_time( $c['created'] ?? 0 ) . '</td><td>' . self::fmt_time( $c['last_used'] ?? 0 ) . '</td><td>' . esc_html( $c['last_ip'] ?? '–' ) . '</td></tr>'; // phpcs:ignore
			}
			echo '</tbody></table>';
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="cbmcp-inline" onsubmit="return confirm(\'' . esc_js( __( 'Verbindung wirklich trennen? Claude verliert sofort den Zugriff.', 'cb-mcp-bridge' ) ) . '\')">';
			wp_nonce_field( 'cbmcp_disconnect' );
			echo '<input type="hidden" name="action" value="cbmcp_disconnect"><button class="button button-link-delete">' . esc_html__( 'Verbindung trennen', 'cb-mcp-bridge' ) . '</button></form>';
		} else {
			echo '<p class="cbmcp-status off"><span class="dashicons dashicons-marker"></span> ' . esc_html__( 'Nicht verbunden', 'cb-mcp-bridge' ) . '</p>';
		}
		if ( ! $avail ) {
			echo '<div class="notice notice-warning inline"><p>' . esc_html__( 'Anwendungspasswörter sind auf dieser Seite nicht verfügbar (meist fehlt HTTPS oder ein Sicherheits-Plugin blockiert sie). Ohne sie kann sich der Server nicht verbinden.', 'cb-mcp-bridge' ) . '</p></div>';
		}
		echo '</div>';

		echo '<div class="cbmcp-card"><h2>' . esc_html__( 'MCP-Server', 'cb-mcp-bridge' ) . '</h2>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'cbmcp_save_settings' );
		echo '<input type="hidden" name="action" value="cbmcp_save_settings"><input type="hidden" name="tab" value="connection">';
		echo '<label for="cbmcp-server" class="cbmcp-label">' . esc_html__( 'Adresse deines MCP-Servers', 'cb-mcp-bridge' ) . '</label>';
		echo '<div class="cbmcp-row"><input id="cbmcp-server" type="url" name="server_url" class="regular-text" placeholder="https://wp-mcp.example.com" value="' . esc_attr( $server ) . '"> <button class="button">' . esc_html__( 'Speichern', 'cb-mcp-bridge' ) . '</button></div>';
		echo '</form>';
		if ( $server ) {
			$connect = add_query_arg(
				array(
					'site'   => rawurlencode( home_url( '/' ) ),
					'return' => rawurlencode( self::url( 'connection' ) ),
				),
				$server . '/admin/connect'
			);
			echo '<p><a class="button button-primary button-hero" href="' . esc_url( $connect ) . '">' . ( $conns ? esc_html__( 'Neu verbinden', 'cb-mcp-bridge' ) : esc_html__( 'Mit MCP-Server verbinden', 'cb-mcp-bridge' ) ) . '</a></p>';
			echo '<p class="description">' . esc_html__( 'Du meldest dich am Server an, bestätigst danach hier in WordPress die Freigabe und landest wieder auf dieser Seite. Es wird ein Anwendungspasswort für deinen Benutzer erstellt, das du jederzeit widerrufen kannst.', 'cb-mcp-bridge' ) . '</p>';
			echo '<p class="description">' . esc_html__( 'Connector-Adresse für Claude:', 'cb-mcp-bridge' ) . ' <code>' . esc_html( $server . '/mcp' ) . '</code></p>';
		}
		echo '</div>';

		$info = CBMCP_Bridge::route_info();
		echo '<div class="cbmcp-card"><h2>' . esc_html__( 'System', 'cb-mcp-bridge' ) . '</h2><table class="cbmcp-kv">';
		$rows = array(
			'WordPress'       => $info['wp_version'],
			'PHP'             => $info['php_version'],
			'Theme'           => $info['theme']['name'] . ( $info['theme']['is_child_theme'] ? ' (Child)' : '' ),
			'Block-Theme'     => $info['theme']['is_block_theme'] ? __( 'ja', 'cb-mcp-bridge' ) : __( 'nein', 'cb-mcp-bridge' ),
			'PHP-Syntaxprüfung' => $info['tokenizer_lint'] ? __( 'aktiv', 'cb-mcp-bridge' ) : __( 'nicht verfügbar', 'cb-mcp-bridge' ),
			'Dateisystem'     => function_exists( 'get_filesystem_method' ) ? get_filesystem_method() : '–',
		);
		foreach ( $rows as $k => $v ) {
			echo '<tr><th>' . esc_html( $k ) . '</th><td>' . esc_html( (string) $v ) . '</td></tr>';
		}
		echo '</table></div>';
	}

	private static function toggle( $key, $label, $desc ) {
		$locked = CBMCP_Settings::locked( $key );
		$on     = CBMCP_Settings::enabled( $key );
		echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td><label class="cbmcp-switch"><input type="checkbox" name="' . esc_attr( $key ) . '" value="1"' . checked( $on, true, false ) . ( null !== $locked ? ' disabled' : '' ) . '><span></span></label>';
		echo '<p class="description">' . esc_html( $desc ) . '</p>';
		if ( null !== $locked ) {
			echo '<p class="description cbmcp-locked"><span class="dashicons dashicons-lock"></span> ' . esc_html__( 'Durch eine Konstante in wp-config.php festgelegt.', 'cb-mcp-bridge' ) . '</p>';
		}
		echo '</td></tr>';
	}

	private static function tab_security() {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="cbmcp-card">';
		wp_nonce_field( 'cbmcp_save_settings' );
		echo '<input type="hidden" name="action" value="cbmcp_save_settings"><input type="hidden" name="tab" value="security">';
		echo '<table class="form-table" role="presentation">';
		self::toggle( 'file_write', __( 'Dateien bearbeiten', 'cb-mcp-bridge' ), __( 'Claude darf Theme- und Plugin-Dateien schreiben und löschen (mit PHP-Prüfung und Backup). Lesen ist immer möglich.', 'cb-mcp-bridge' ) );
		self::toggle( 'snippets', __( 'PHP-Snippets', 'cb-mcp-bridge' ), __( 'Claude darf PHP-Snippets anlegen, die bei jedem Seitenaufruf laufen. Fehlerhafte Snippets werden automatisch abgeschaltet.', 'cb-mcp-bridge' ) );
		self::toggle( 'db_write', __( 'Datenbank schreiben', 'cb-mcp-bridge' ), __( 'Erlaubt SQL INSERT/UPDATE/DELETE/REPLACE (immer mit WHERE, keine Schemaänderungen). Lesende Abfragen sind immer möglich.', 'cb-mcp-bridge' ) );
		self::toggle( 'safe_mode', __( 'Notfallmodus', 'cb-mcp-bridge' ), __( 'Führt keine Snippets aus. Für den Fall, dass ein Snippet die Seite stört.', 'cb-mcp-bridge' ) );
		self::toggle( 'notices', __( 'Live-Hinweise', 'cb-mcp-bridge' ), __( 'Zeigt Administratoren im Backend und in der Admin-Leiste, was Claude gerade geändert hat.', 'cb-mcp-bridge' ) );
		echo '</table><p><button class="button button-primary">' . esc_html__( 'Speichern', 'cb-mcp-bridge' ) . '</button></p></form>';
	}

	private static function tab_activity() {
		CBMCP_Activity::mark_seen( get_current_user_id() );
		$rows = CBMCP_Activity::recent( 200 );
		echo '<div class="cbmcp-card"><h2>' . esc_html__( 'Aktivität', 'cb-mcp-bridge' ) . '</h2>';
		if ( ! $rows ) {
			echo '<p>' . esc_html__( 'Noch keine Aktivität.', 'cb-mcp-bridge' ) . '</p></div>';
			return;
		}
		echo '<table class="widefat striped cbmcp-activity"><thead><tr><th>' . esc_html__( 'Zeit', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Aktion', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Status', 'cb-mcp-bridge' ) . '</th><th></th></tr></thead><tbody>';
		foreach ( $rows as $r ) {
			$status = 'error' === $r['status'] ? '<span class="cbmcp-pill err">' . esc_html__( 'Fehler', 'cb-mcp-bridge' ) . '</span>' : ( 'approval' === $r['kind'] ? '<span class="cbmcp-pill wait">' . esc_html__( 'Freigabe', 'cb-mcp-bridge' ) . '</span>' : '<span class="cbmcp-pill ok">OK</span>' );
			$links  = '';
			if ( $r['link'] ) {
				$links .= '<a href="' . esc_url( $r['link'] ) . '" target="_blank" rel="noopener">' . ( 'approval' === $r['kind'] ? esc_html__( 'Öffnen', 'cb-mcp-bridge' ) : esc_html__( 'Ansehen', 'cb-mcp-bridge' ) ) . '</a>';
			}
			if ( $r['edit_link'] ) {
				$links .= ( $links ? ' · ' : '' ) . '<a href="' . esc_url( $r['edit_link'] ) . '">' . esc_html__( 'Bearbeiten', 'cb-mcp-bridge' ) . '</a>';
			}
			echo '<tr><td class="cbmcp-nowrap">' . esc_html( get_date_from_gmt( $r['created'], get_option( 'date_format' ) . ' H:i' ) ) . '</td><td><code>' . esc_html( $r['tool'] ) . '</code> ' . esc_html( $r['summary'] ) . '</td><td>' . $status . '</td><td class="cbmcp-nowrap">' . $links . '</td></tr>'; // phpcs:ignore
		}
		echo '</tbody></table></div>';
	}

	private static function tab_snippets() {
		$list = CBMCP_Bridge::route_snippets_list();
		echo '<div class="cbmcp-card"><h2>' . esc_html__( 'PHP-Snippets', 'cb-mcp-bridge' ) . '</h2>';
		if ( empty( $list['snippets'] ) ) {
			echo '<p>' . esc_html__( 'Noch keine Snippets. Claude legt sie mit dem Tool manage_snippet an.', 'cb-mcp-bridge' ) . '</p></div>';
			return;
		}
		if ( $list['safe_mode'] ) {
			echo '<div class="notice notice-warning inline"><p>' . esc_html__( 'Notfallmodus aktiv: Snippets werden nicht ausgeführt.', 'cb-mcp-bridge' ) . '</p></div>';
		}
		echo '<table class="widefat striped"><thead><tr><th>Name</th><th>' . esc_html__( 'Beschreibung', 'cb-mcp-bridge' ) . '</th><th>Status</th><th>' . esc_html__( 'Aktionen', 'cb-mcp-bridge' ) . '</th></tr></thead><tbody>';
		foreach ( $list['snippets'] as $s ) {
			$req = new WP_REST_Request( 'GET' );
			$req->set_param( 'name', $s['name'] );
			$full = CBMCP_Bridge::route_snippets_get( $req );
			$code = is_wp_error( $full ) ? '' : $full['code'];
			echo '<tr><td><strong>' . esc_html( $s['name'] ) . '</strong><details><summary>' . esc_html__( 'Code', 'cb-mcp-bridge' ) . '</summary><pre class="cbmcp-code">' . esc_html( $code ) . '</pre></details></td>';
			echo '<td>' . esc_html( $s['description'] ?? '' ) . ( ! empty( $s['error'] ) ? '<p class="cbmcp-error">' . esc_html( $s['error'] ) . '</p>' : '' ) . '</td>';
			echo '<td>' . ( ! empty( $s['active'] ) ? '<span class="cbmcp-pill ok">' . esc_html__( 'aktiv', 'cb-mcp-bridge' ) . '</span>' : '<span class="cbmcp-pill">' . esc_html__( 'aus', 'cb-mcp-bridge' ) . '</span>' ) . '</td><td class="cbmcp-nowrap">';
			foreach ( array( ! empty( $s['active'] ) ? 'disable' : 'enable', 'delete' ) as $do ) {
				$label = array(
					'enable'  => __( 'Aktivieren', 'cb-mcp-bridge' ),
					'disable' => __( 'Deaktivieren', 'cb-mcp-bridge' ),
					'delete'  => __( 'Löschen', 'cb-mcp-bridge' ),
				)[ $do ];
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="cbmcp-inline"' . ( 'delete' === $do ? ' onsubmit="return confirm(\'' . esc_js( __( 'Snippet löschen?', 'cb-mcp-bridge' ) ) . '\')"' : '' ) . '>';
				wp_nonce_field( 'cbmcp_snippet' );
				echo '<input type="hidden" name="action" value="cbmcp_snippet"><input type="hidden" name="name" value="' . esc_attr( $s['name'] ) . '"><input type="hidden" name="do" value="' . esc_attr( $do ) . '"><button class="button button-small' . ( 'delete' === $do ? ' button-link-delete' : '' ) . '">' . esc_html( $label ) . '</button></form> ';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table></div>';
	}

	private static function tab_backups() {
		$items = CBMCP_Bridge::list_all_backups( 300 );
		echo '<div class="cbmcp-card"><h2>' . esc_html__( 'Backups', 'cb-mcp-bridge' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'Vor jeder Änderung durch Claude wird der vorherige Stand gesichert (letzte 10 je Datei bzw. Feld). Beim Wiederherstellen wird der aktuelle Stand ebenfalls gesichert.', 'cb-mcp-bridge' ) . '</p>';
		if ( ! $items ) {
			echo '<p>' . esc_html__( 'Noch keine Backups.', 'cb-mcp-bridge' ) . '</p></div>';
			return;
		}
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Zeit', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Art', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Ziel', 'cb-mcp-bridge' ) . '</th><th>' . esc_html__( 'Größe', 'cb-mcp-bridge' ) . '</th><th></th></tr></thead><tbody>';
		foreach ( $items as $b ) {
			echo '<tr><td class="cbmcp-nowrap">' . esc_html( wp_date( 'd.m.Y H:i:s', $b['time'] ) ) . '</td><td>' . esc_html( 'meta' === $b['type'] ? 'Meta-Feld' : 'Datei' ) . '</td><td><code>' . esc_html( $b['target'] ) . '</code></td><td>' . esc_html( size_format( $b['size'] ) ) . '</td><td>';
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" onsubmit="return confirm(\'' . esc_js( __( 'Diesen Stand wiederherstellen?', 'cb-mcp-bridge' ) ) . '\')">';
			wp_nonce_field( 'cbmcp_restore' );
			echo '<input type="hidden" name="action" value="cbmcp_restore"><input type="hidden" name="backup" value="' . esc_attr( $b['name'] ) . '"><button class="button button-small">' . esc_html__( 'Wiederherstellen', 'cb-mcp-bridge' ) . '</button></form></td></tr>';
		}
		echo '</tbody></table></div>';
	}
}
