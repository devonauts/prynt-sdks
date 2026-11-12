<?php
/**
 * Plugin Name:       Prynt — Device Intelligence & Fraud Protection
 * Plugin URI:        https://pryntid.com
 * Description:       Cloud device intelligence for WordPress. Identify visitors and stop bot/spam submissions on login, registration, comments and WooCommerce checkout — with honeypot, timing and Cyrillic/CJK content spam detection. Plus Prynt Reveal: see which companies visit your site (connect with a one-time setup code).
 * Version:           1.2.0
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            Prynt
 * Author URI:        https://pryntid.com
 * License:           MIT
 * Text Domain:       prynt
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'PRYNT_VERSION', '1.2.0' );
define( 'PRYNT_FILE', __FILE__ );
define( 'PRYNT_DIR', plugin_dir_path( __FILE__ ) );
define( 'PRYNT_URL', plugin_dir_url( __FILE__ ) );
define( 'PRYNT_OPTION', 'prynt_settings' );

require_once PRYNT_DIR . 'includes/class-prynt-client.php';
require_once PRYNT_DIR . 'includes/class-prynt-settings.php';
require_once PRYNT_DIR . 'includes/class-prynt-protect.php';
require_once PRYNT_DIR . 'includes/class-prynt-reveal.php';

/**
 * Default settings, merged with saved options.
 */
function prynt_defaults() {
	return array(
		'endpoint'      => 'https://api.pryntid.com',
		'public_key'    => '',
		'secret_key'    => '',
		'mode'          => 'monitor', // monitor | block
		'block_score'   => 70,        // riskScore threshold for block mode
		'protect_login' => 1,
		'protect_register' => 1,
		'protect_comments' => 0,
		'protect_woocommerce' => 1,
		'expected_scripts' => 'latin', // comma-separated scripts a form legitimately expects
		// Prynt Reveal (B2B visitor identification): the website's PUBLIC key + domain, set by "Connect".
		'reveal_public_key' => '',
		'reveal_website'    => '',
	);
}

function prynt_get_settings() {
	return wp_parse_args( get_option( PRYNT_OPTION, array() ), prynt_defaults() );
}

function prynt_is_configured() {
	$s = prynt_get_settings();
	return ! empty( $s['endpoint'] ) && ! empty( $s['public_key'] );
}

// Boot.
add_action( 'plugins_loaded', function () {
	new Prynt_Settings();
	new Prynt_Protect();
	new Prynt_Reveal();
} );

// Activation: seed defaults + a friendly setup notice.
register_activation_hook( __FILE__, function () {
	if ( false === get_option( PRYNT_OPTION ) ) {
		add_option( PRYNT_OPTION, prynt_defaults() );
	}
	set_transient( 'prynt_activated', 1, 30 );
} );

add_action( 'admin_notices', function () {
	if ( get_transient( 'prynt_activated' ) ) {
		delete_transient( 'prynt_activated' );
		$url = esc_url( admin_url( 'admin.php?page=prynt' ) );
		echo '<div class="notice notice-info is-dismissible"><p>'
			. wp_kses_post( sprintf( __( 'Prynt is active. <a href="%s">Connect Reveal or add your API keys</a> to get started.', 'prynt' ), $url ) )
			. '</p></div>';
	}
} );
