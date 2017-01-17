FROM arangodb:latest
ADD . /var/lib/arangodb3-apps/_db/juntosfoxx/juntos/APP
ADD ./init-db.sh /init-db.sh
RUN chmod a+x /init-db.sh
ENTRYPOINT ["/init-db.sh"]
CMD ["arangod"]
