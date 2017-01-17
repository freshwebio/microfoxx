# microfoxx

Provides a Foxx service that exposes the following endpoints:

On all modification requests a new event is created within a single transaction which is exposed
to a service which could then be used for the case of event publishing through a message-broker to make
sure all subscribed services are up to date.

### Docker
For running this as a docker container as an extension of the ArangoDB image there are environment variables that are required
for this to work.

The environment variables expected are:

MF_DB_USERNAME - The username of the single user in order to access the microfoxx app endpoints.

MF_DB_PASSWORD - The password for the single user to access the microfoxx app.

As well as this see the official ArangoDB docker image to find out which other environment variables are supported
and or required.