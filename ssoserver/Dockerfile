FROM php:8.3-apache

ARG SIMPLESAMLPHP_VERSION=2.4.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git libicu-dev libxml2-dev unzip \
  && docker-php-ext-install intl \
  && a2enmod rewrite \
  && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

RUN composer create-project --no-dev --prefer-dist simplesamlphp/simplesamlphp:${SIMPLESAMLPHP_VERSION} /var/www/simplesamlphp \
  && mkdir -p /var/www/html /var/www/simplesamlphp/cert /var/www/simplesamlphp/config /var/www/simplesamlphp/metadata /tmp/simplesamlphp/cache /tmp/simplesamlphp/temp \
  && chown -R www-data:www-data /tmp/simplesamlphp \
  && chown -R www-data:www-data /var/www/simplesamlphp /var/www/html

COPY apache/000-default.conf /etc/apache2/sites-available/000-default.conf
COPY html/index.php /var/www/html/index.php
