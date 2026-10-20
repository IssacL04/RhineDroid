"""User-selected first internal model, restored from revision 89c7742.

Keep the current outer case and reveal animation. This shared Blender source
restores the annular lenses, inner hubs, muted orange and paired ribbons.
"""
amber_inlay=material('Amber_Optical_Inlay',(.48,.18,.052),.32,.28)
film=material('Optical_Film',(.79,.755,.712),.30,.06)
film_edge=material('Optical_Film_Edge',(.57,.545,.515),.27,.20)
clip_metal=material('Optical_Clips',(.34,.335,.32),.34,.55)

# Large annular volume: broad, segmented shallow chamber surrounding a narrow raised bore.
# The previous uniformly thick concentric tubes hid the asymmetric breaks.
bx,bz=-.425,1.80
outer_profile=[(.625,.013),(.918,.013),(.950,.004),(.949,-.010),
               (.928,-.023),(.897,-.037),(.848,-.046),(.717,-.048),
               (.667,-.044),(.635,-.030)]
for start,end in [(1,89.7),(90.3,177.5),(181,227.5),(229,308.7),(309.3,359.7)]:
    annular_profile('Embedded optical cavity segment',bx,bz,outer_profile,optics,128,
                    math.radians(start),math.radians(end))
# Each lip has its own depth so the cross-section stays readable when unassembled.
annular_profile('Inner optical bevel hub',bx,bz,[
    (.501,-.020),(.614,-.020),(.635,-.033),(.632,-.057),
    (.615,-.069),(.547,-.071),(.512,-.056),(.501,-.040)],optical_edge)
for start,end in [(2,177),(181,227),(230,359)]:
    annular_profile('Subsurface refractive shoulder sector',bx,bz,[
        (.670,-.031),(.929,-.010),(.948,-.017),(.942,-.026),
        (.914,-.034),(.867,-.043),(.731,-.054),(.673,-.049)],optical_edge,128,
        math.radians(start),math.radians(end))
# Thin glazing lips and a partial inner copper track seen at the upper-left.
for radius,depth in [(.943,-.029),(.650,-.054),(.526,-.064)]:
    annular_profile('Concentric optical machining lip',bx,bz,[
        (radius-.004,depth+.003),(radius+.004,depth+.003),
        (radius+.005,depth-.001),(radius,depth-.004),
        (radius-.004,depth-.002)],film_edge)
annular_profile('Embedded amber annulus inner arc',bx,bz,[
    (.546,-.061),(.568,-.061),(.574,-.070),(.568,-.075),(.548,-.075)],amber_inlay,
    128,math.radians(109),math.radians(225))
annular_profile('Embedded amber annulus outer arc',bx,bz,[
    (.910,.009),(.982,.009),(.986,-.004),(.978,-.011),(.953,-.020),(.922,-.017)],amber_inlay,
    128,math.radians(229),math.radians(364))
# Radial joints cross the wide outer lens, staying under the cover.
for angle in [90,103,179,228,260,309]:
    a=math.radians(angle)
    channel('Concentric optical machining radial seam',
        [(bx+r*math.cos(a),bz+r*math.sin(a)) for r in [.674,.74,.88,.937]],
        -.057,.0024,film_edge)

# Small annular volume: concentric clear shoulder, darker seat, flat amber annulus and hub.
sx,sz=1.125,2.455
annular_profile('Embedded optical cavity small',sx,sz,[
    (.220,.014),(.511,.014),(.555,.000),(.560,-.015),
    (.529,-.035),(.471,-.050),(.360,-.055),(.231,-.037)],optics)
annular_profile('Subsurface refractive shoulder small',sx,sz,[
    (.388,-.034),(.536,-.013),(.573,-.017),(.579,-.030),
    (.553,-.047),(.502,-.059),(.424,-.063),(.386,-.051)],optical_edge)
annular_profile('Embedded amber annulus small',sx,sz,[
    (.230,-.045),(.347,-.045),(.356,-.056),(.351,-.071),
    (.241,-.071),(.230,-.060)],amber_inlay)
annular_profile('Inner optical bevel small hub',sx,sz,[
    (.170,-.041),(.226,-.041),(.235,-.054),(.231,-.069),
    (.184,-.069),(.172,-.057)],optical_edge)
for radius in [.381,.478,.565]:
    annular_profile('Concentric optical machining small lip',sx,sz,[
        (radius-.003,-.057),(radius+.003,-.057),(radius+.004,-.062),
        (radius,-.064),(radius-.003,-.062)],film_edge)

# The reference shows two nearly clear ribbon-like spans. Their physical role is
# unknown; recreate visible sheet/rim geometry without inventing a mechanism.
def ribbon(name, controls, width, depth):
    points=[];verts=[];faces=[];segments=40
    for i in range(segments+1):
        t=i/segments;u=1-t
        x=sum(w*p[0] for w,p in zip([u**3,3*u*u*t,3*u*t*t,t**3],controls))
        z=sum(w*p[1] for w,p in zip([u**3,3*u*u*t,3*u*t*t,t**3],controls))
        dx=3*u*u*(controls[1][0]-controls[0][0])+6*u*t*(controls[2][0]-controls[1][0])+3*t*t*(controls[3][0]-controls[2][0])
        dz=3*u*u*(controls[1][1]-controls[0][1])+6*u*t*(controls[2][1]-controls[1][1])+3*t*t*(controls[3][1]-controls[2][1])
        length=math.hypot(dx,dz);nx=-dz/length;nz=dx/length
        points.append(((x-width*nx/2,z-width*nz/2),(x+width*nx/2,z+width*nz/2)))
        for yy in [depth-.002,depth+.002]:
            for sign in [-1,1]:verts.append((x+sign*width*nx/2,yy,z+sign*width*nz/2))
    for i in range(segments):
        a=i*4;b=(i+1)*4
        faces.extend([(a,b,b+1,a+1),(a+2,a+3,b+3,b+2),
                      (a,a+2,b+2,b),(a+1,b+1,b+3,a+3)])
    faces.extend([(0,1,3,2),(segments*4,segments*4+2,segments*4+3,segments*4+1)])
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj);mesh.materials.append(film)
    for face in mesh.polygons:face.use_smooth=True
    for side in [0,1]:channel(name+' edge',[p[side] for p in points],depth-.003,.0018,film_edge)

ribbon('Optical ribbon inner',[(.31,1.16),(.99,1.33),(1.00,1.78),(.73,2.20)],.10,-.008)
ribbon('Optical ribbon outer',[(.03,.94),(.97,1.13),(1.14,1.75),(.84,2.13)],.11,.007)
channel('Optical ribbon tangent upper',[(-.67,2.73),(.98,3.01)],.003,.0018,film_edge)
channel('Optical ribbon tangent lower',[(.06,.91),(1.44,2.03)],.006,.0018,film_edge)

# Omit the three tall structures to the left, as requested: their depth would
# exceed the cassette. Use the 46–51 second views only for the annular buildings.
# Closely spaced facade mullions sit under the roof edge, visible from oblique views.
for cx,cz,r,count in [(bx,bz,.945,84),(sx,sz,.544,52)]:
    for i in range(count):
        angle=2*math.pi*i/count
        if cx==bx and 177<math.degrees(angle)<182:continue
        obj=cube('Embedded optical cavity facade mullion',
            (cx+r*math.cos(angle),-.011,cz+r*math.sin(angle)),(.009,.056,.0034),film_edge,.001)
        obj.rotation_euler.y=-angle
annular_profile('Embedded amber annulus small lower fascia',sx,sz,[
    (.526,.010),(.557,.010),(.561,.001),(.558,-.009),(.532,-.009)],amber_inlay)
