<?php
/**
 * Plugin Name:       FreeBird
 * Plugin URI:        https://freebird.dev
 * Description:       Adds a component-aware FreeBird AI chatbot to your site and registers your pages, posts, and products so the assistant can help visitors with them.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            FreeBird
 * License:           MIT
 * Text Domain:       freebird
 *
 * v0: injects the @freebirdai/embed script, pushes content digests to the
 * managed backend on save (no inbound access to wp-admin required), exposes a
 * one-time pairing handshake for FreeBird Studio, and ships a
 * [freebird_component] shortcode / block for annotating page regions.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'FREEBIRD_WP_VERSION', '0.1.0' );
define( 'FREEBIRD_WP_OPTION', 'freebird_wp_settings' );
define( 'FREEBIRD_WP_DEFAULT_CDN', 'https://cdn.freebird.dev/v1/freebird.js' );

/**
 * Settings accessor with defaults.
 *
 * @return array{site_id:string,api_base:string,secret:string,enable_chat:bool,push_content:bool,cdn_url:string}
 */
function freebird_wp_settings() {
	$defaults = array(
		'site_id'      => '',
		'api_base'     => '',
		'secret'       => '',
		'enable_chat'  => true,
		'push_content' => true,
		'cdn_url'      => FREEBIRD_WP_DEFAULT_CDN,
	);
	$stored = get_option( FREEBIRD_WP_OPTION, array() );
	return wp_parse_args( is_array( $stored ) ? $stored : array(), $defaults );
}

/** True when the plugin is configured enough to talk to the backend. */
function freebird_wp_is_configured() {
	$s = freebird_wp_settings();
	return '' !== $s['site_id'] && '' !== $s['api_base'];
}

/* -------------------------------------------------------------------------
 * 1. Embed injection
 * ---------------------------------------------------------------------- */

/**
 * Enqueue the FreeBird embed on the public site with the site's data
 * attributes. The embed's DOM scanner + our shortcode/block do registration.
 */
function freebird_wp_enqueue_embed() {
	$s = freebird_wp_settings();
	if ( ! $s['enable_chat'] || '' === $s['site_id'] ) {
		return;
	}
	// Registering with a src and then filtering the tag lets us add the
	// data-* attributes the embed reads from its own <script> element.
	wp_register_script( 'freebird-embed', $s['cdn_url'], array(), FREEBIRD_WP_VERSION, false );
	wp_enqueue_script( 'freebird-embed' );

	add_filter(
		'script_loader_tag',
		function ( $tag, $handle ) use ( $s ) {
			if ( 'freebird-embed' !== $handle ) {
				return $tag;
			}
			$attrs = sprintf(
				' data-site-id="%s" data-api="%s" defer',
				esc_attr( $s['site_id'] ),
				esc_attr( $s['api_base'] )
			);
			// Insert our attributes before the closing > of the <script ...> tag.
			return preg_replace( '/(<script\b[^>]*?)(\s*>)/', '$1' . $attrs . '$2', $tag, 1 );
		},
		10,
		2
	);
}
add_action( 'wp_enqueue_scripts', 'freebird_wp_enqueue_embed' );

/* -------------------------------------------------------------------------
 * 2. Shortcode + block: annotate a region as a FreeBird component
 * ---------------------------------------------------------------------- */

/**
 * [freebird_component id="hours" title="Opening hours" description="..."]...[/freebird_component]
 * Wraps its content in the data-freebird-* attributes the embed scanner reads.
 */
function freebird_wp_component_shortcode( $atts, $content = '' ) {
	$atts = shortcode_atts(
		array(
			'id'          => '',
			'title'       => '',
			'description' => '',
			'tags'        => '',
		),
		$atts,
		'freebird_component'
	);
	if ( '' === $atts['id'] ) {
		return do_shortcode( $content );
	}
	$attr_html = sprintf(
		'data-freebird-component="%s"',
		esc_attr( $atts['id'] )
	);
	if ( '' !== $atts['title'] ) {
		$attr_html .= sprintf( ' data-freebird-title="%s"', esc_attr( $atts['title'] ) );
	}
	if ( '' !== $atts['description'] ) {
		$attr_html .= sprintf( ' data-freebird-description="%s"', esc_attr( $atts['description'] ) );
	}
	if ( '' !== $atts['tags'] ) {
		$attr_html .= sprintf( ' data-freebird-tags="%s"', esc_attr( $atts['tags'] ) );
	}
	return sprintf( '<div %s>%s</div>', $attr_html, do_shortcode( $content ) );
}
add_shortcode( 'freebird_component', 'freebird_wp_component_shortcode' );

/* -------------------------------------------------------------------------
 * 3. Push-model content registration
 * ---------------------------------------------------------------------- */

/**
 * Build a wp-content manifest entry for a post/page/product.
 *
 * @param WP_Post $post Post object.
 * @return array<string,mixed>
 */
function freebird_wp_content_entry( $post ) {
	$id = 'wp_' . $post->post_type . '_' . $post->ID;
	$plain = wp_strip_all_tags( $post->post_content );
	$plain = trim( preg_replace( '/\s+/', ' ', $plain ) );
	if ( strlen( $plain ) > 4000 ) {
		$plain = substr( $plain, 0, 4000 ) . '…';
	}
	return array(
		'id'          => $id,
		'title'       => $post->post_title,
		'description' => sprintf( 'The "%s" %s.', $post->post_title, $post->post_type ),
		'kind'        => 'wp-content',
		'source'      => array(
			'wpType' => $post->post_type,
			'wpId'   => $post->ID,
		),
		'knowledge'   => array( $plain ),
		'tags'        => wp_get_post_tags( $post->ID, array( 'fields' => 'names' ) ),
	);
}

/**
 * POST a content digest to the managed backend, signed with the per-site
 * secret (HMAC-SHA256 over the JSON body, matching @freebirdai/manifest's
 * webhook signature convention).
 *
 * @param WP_Post $post Post object.
 */
function freebird_wp_push_content( $post ) {
	if ( ! freebird_wp_is_configured() ) {
		return;
	}
	$s = freebird_wp_settings();
	if ( ! $s['push_content'] ) {
		return;
	}
	if ( wp_is_post_revision( $post ) || wp_is_post_autosave( $post ) || 'publish' !== $post->post_status ) {
		return;
	}

	$manifest = array(
		'version'    => 1,
		'siteId'     => $s['site_id'],
		'components' => array( freebird_wp_content_entry( $post ) ),
	);
	$body = wp_json_encode( array( 'manifest' => $manifest ) );

	$headers = array( 'Content-Type' => 'application/json' );
	if ( '' !== $s['secret'] ) {
		$headers['X-FreeBird-Signature'] = hash_hmac( 'sha256', $body, $s['secret'] );
	}

	$url = trailingslashit( $s['api_base'] ) . 'v1/sites/' . rawurlencode( $s['site_id'] ) . '/content';
	wp_remote_post(
		$url,
		array(
			'timeout'  => 8,
			'blocking' => false, // fire-and-forget; don't slow down the editor
			'headers'  => $headers,
			'body'     => $body,
		)
	);
}

/**
 * Hook post saves. Covers pages/posts and (when present) WooCommerce products,
 * since products are the `product` post type and also fire save_post.
 *
 * @param int     $post_id Post ID.
 * @param WP_Post $post    Post object.
 */
function freebird_wp_on_save_post( $post_id, $post ) {
	if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
		return;
	}
	freebird_wp_push_content( $post );
}
add_action( 'save_post', 'freebird_wp_on_save_post', 20, 2 );

/* -------------------------------------------------------------------------
 * 4. Pairing handshake for FreeBird Studio
 * ---------------------------------------------------------------------- */

/**
 * Rotate and return a one-time pairing code shown on the settings screen.
 * Studio POSTs it back to verify ownership of this site.
 *
 * @return string
 */
function freebird_wp_get_pairing_code() {
	$code = get_option( 'freebird_wp_pairing_code' );
	if ( ! $code ) {
		$code = strtoupper( wp_generate_password( 8, false, false ) );
		update_option( 'freebird_wp_pairing_code', $code, false );
	}
	return $code;
}

/** Register the pairing REST endpoint. */
function freebird_wp_register_rest() {
	register_rest_route(
		'freebird/v1',
		'/pair',
		array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => 'freebird_wp_rest_pair',
			'args'                => array(
				'code' => array( 'required' => true, 'type' => 'string' ),
			),
		)
	);
}
add_action( 'rest_api_init', 'freebird_wp_register_rest' );

/**
 * Verify a pairing code. On success, returns the site metadata Studio needs to
 * bind this WordPress site, and clears the one-time code.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response
 */
function freebird_wp_rest_pair( $request ) {
	$provided = (string) $request->get_param( 'code' );
	$expected = get_option( 'freebird_wp_pairing_code' );
	if ( ! $expected || ! hash_equals( (string) $expected, $provided ) ) {
		return new WP_REST_Response( array( 'ok' => false, 'error' => 'invalid_code' ), 403 );
	}
	// One-time: rotate immediately after a successful pair.
	delete_option( 'freebird_wp_pairing_code' );

	$s = freebird_wp_settings();
	return new WP_REST_Response(
		array(
			'ok'       => true,
			'site'     => array(
				'name'     => get_bloginfo( 'name' ),
				'url'      => home_url(),
				'wpVersion'=> get_bloginfo( 'version' ),
				'plugin'   => FREEBIRD_WP_VERSION,
				'hasWoo'   => class_exists( 'WooCommerce' ),
			),
		),
		200
	);
}

/* -------------------------------------------------------------------------
 * 5. Settings screen
 * ---------------------------------------------------------------------- */

function freebird_wp_admin_menu() {
	add_options_page(
		'FreeBird',
		'FreeBird',
		'manage_options',
		'freebird',
		'freebird_wp_render_settings'
	);
}
add_action( 'admin_menu', 'freebird_wp_admin_menu' );

function freebird_wp_register_settings() {
	register_setting(
		'freebird_wp',
		FREEBIRD_WP_OPTION,
		array( 'sanitize_callback' => 'freebird_wp_sanitize_settings' )
	);
}
add_action( 'admin_init', 'freebird_wp_register_settings' );

/**
 * @param mixed $input Raw settings input.
 * @return array<string,mixed>
 */
function freebird_wp_sanitize_settings( $input ) {
	$input = is_array( $input ) ? $input : array();
	return array(
		'site_id'      => isset( $input['site_id'] ) ? sanitize_text_field( $input['site_id'] ) : '',
		'api_base'     => isset( $input['api_base'] ) ? esc_url_raw( $input['api_base'] ) : '',
		'secret'       => isset( $input['secret'] ) ? sanitize_text_field( $input['secret'] ) : '',
		'enable_chat'  => ! empty( $input['enable_chat'] ),
		'push_content' => ! empty( $input['push_content'] ),
		'cdn_url'      => isset( $input['cdn_url'] ) && '' !== $input['cdn_url']
			? esc_url_raw( $input['cdn_url'] )
			: FREEBIRD_WP_DEFAULT_CDN,
	);
}

function freebird_wp_render_settings() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$s    = freebird_wp_settings();
	$code = freebird_wp_get_pairing_code();
	?>
	<div class="wrap">
		<h1>FreeBird</h1>

		<div class="notice notice-info" style="padding:12px 16px;">
			<strong>Pair with FreeBird Studio:</strong>
			enter this one-time code in Studio to connect this site —
			<code style="font-size:16px;letter-spacing:2px;"><?php echo esc_html( $code ); ?></code>
		</div>

		<form method="post" action="options.php">
			<?php settings_fields( 'freebird_wp' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="fb_site_id">Site ID</label></th>
					<td>
						<input name="<?php echo esc_attr( FREEBIRD_WP_OPTION ); ?>[site_id]"
						       id="fb_site_id" type="text" class="regular-text"
						       value="<?php echo esc_attr( $s['site_id'] ); ?>" placeholder="fb_..." />
						<p class="description">From your FreeBird Studio dashboard.</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="fb_api">API base URL</label></th>
					<td>
						<input name="<?php echo esc_attr( FREEBIRD_WP_OPTION ); ?>[api_base]"
						       id="fb_api" type="url" class="regular-text"
						       value="<?php echo esc_attr( $s['api_base'] ); ?>" placeholder="https://api.freebird.cloud" />
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="fb_secret">Signing secret</label></th>
					<td>
						<input name="<?php echo esc_attr( FREEBIRD_WP_OPTION ); ?>[secret]"
						       id="fb_secret" type="password" class="regular-text"
						       value="<?php echo esc_attr( $s['secret'] ); ?>" autocomplete="off" />
						<p class="description">Used to sign content pushes (HMAC-SHA256).</p>
					</td>
				</tr>
				<tr>
					<th scope="row">Features</th>
					<td>
						<label>
							<input type="checkbox" name="<?php echo esc_attr( FREEBIRD_WP_OPTION ); ?>[enable_chat]"
							       value="1" <?php checked( $s['enable_chat'] ); ?> />
							Show the chat widget on the site
						</label><br />
						<label>
							<input type="checkbox" name="<?php echo esc_attr( FREEBIRD_WP_OPTION ); ?>[push_content]"
							       value="1" <?php checked( $s['push_content'] ); ?> />
							Push page/post/product content to FreeBird on save
						</label>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}
