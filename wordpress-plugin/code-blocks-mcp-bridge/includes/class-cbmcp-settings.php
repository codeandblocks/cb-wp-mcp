<?php
/**
 * Code & Blocks MCP Bridge – settings (stored as option, overridable by wp-config constants).
 *
 * @package CodeBlocksMcpBridge
 * Author: Code & Blocks by Marijan
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CBMCP_Settings {

	const OPTION = 'cbmcp_settings';

	/** Default values for a fresh install. */
	const DEFAULTS = array(
		'server_url' => '',
		'file_write' => true,
		'snippets'   => true,
		'db_write'   => false,
		'safe_mode'  => false,
		'notices'    => true,
	);

	/**
	 * Constants that override the stored value: key => [ constant, invert ].
	 * "invert" means the constant disables the feature (DISABLE_…).
	 */
	const CONSTANTS = array(
		'file_write' => array( 'CBMCP_DISABLE_FILE_WRITE', true ),
		'snippets'   => array( 'CBMCP_DISABLE_SNIPPETS', true ),
		'db_write'   => array( 'CBMCP_ALLOW_DB_WRITE', false ),
		'safe_mode'  => array( 'CBMCP_SAFE_MODE', false ),
	);

	public static function all() {
		$stored = get_option( self::OPTION, array() );
		return array_merge( self::DEFAULTS, is_array( $stored ) ? $stored : array() );
	}

	public static function get( $key ) {
		$all = self::all();
		return $all[ $key ] ?? null;
	}

	/** Value forced by a wp-config.php constant, or null when the UI setting applies. */
	public static function locked( $key ) {
		if ( ! isset( self::CONSTANTS[ $key ] ) ) {
			return null;
		}
		list( $const, $invert ) = self::CONSTANTS[ $key ];
		if ( ! defined( $const ) ) {
			return null;
		}
		$v = (bool) constant( $const );
		return $invert ? ! $v : $v;
	}

	/** Effective boolean value (constant wins over the stored setting). */
	public static function enabled( $key ) {
		$locked = self::locked( $key );
		return null !== $locked ? $locked : (bool) self::get( $key );
	}

	public static function update( array $values ) {
		$all = self::all();
		foreach ( $values as $k => $v ) {
			if ( ! array_key_exists( $k, self::DEFAULTS ) ) {
				continue;
			}
			$all[ $k ] = is_bool( self::DEFAULTS[ $k ] ) ? (bool) $v : (string) $v;
		}
		update_option( self::OPTION, $all, true );
	}
}
