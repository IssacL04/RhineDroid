# Detail reconstruction from the clear 40–42 second reference.
# Executed by build_archive.py in the same scene; assembly uses this identical source.
# All dimensions below are BEFORE the shared x2 thickness bake.
from pathlib import Path

obsolete=('Embedded optical cavity','Subsurface refractive shoulder','Inner optical bevel',
          'Concentric optical machining','Embedded amber annulus','Moulded circuit channel',
          'Moulded inner perimeter','Moulded vent footing','Laser etched vent',
          'Calibration mark','Edge inscription','Engraved circuit trace')
for obj in list(scene.objects):
    if obj.name.startswith(obsolete): bpy.data.objects.remove(obj,do_unlink=True)

emboss=material('Moulded_Lettering',(.81,.786,.75),.24,.13)
architecture_script=Path(ROOT)/'art/internal_architecture.py'
exec(compile(architecture_script.read_text(encoding='utf-8'),str(architecture_script),'exec'))

# Rebuild the moulding from normalized positions on the complete 41.0-second face.
def face_point(px,py):return ((px-432)/1022*5-2.5,(1018-py)/676*3.7)
def mould(name,pixels,depth=-.074,radius=.004,mat=core):
    return channel(name,[face_point(x,y) for x,y in pixels],depth,radius,mat)

shell_script=Path(ROOT)/'art/shell_reference_details.py'
exec(compile(shell_script.read_text(encoding='utf-8'),str(shell_script),'exec'))

# Fine, lightly recessed rectangular backing routes, beneath the ring structures.
for route in [[(681,470),(681,899),(1061,899),(1061,821),(1310,821),(1310,464),(1028,464),(1028,406)]]:
    mould('Information substrate fine route',route,.014,.0018,core)

# Embossed vertical company inscription belongs to the inner cover, not the ink label.
inscription=text('Moulded vertical lettering','RHINE LAB, LLC.',0,0,.155,emboss)
# Text baseline follows Blender local X; rotate it down the left edge in the X/Z plane.
inscription.location=(-2.27,-.078,2.29)
inscription.rotation_euler=(math.pi/2,math.pi/2,0)
inscription.data.extrude=.003;inscription.data.bevel_depth=.0015;inscription.data.bevel_resolution=1
inscription.data.space_character=1.10
# Two small registration pads under the floating tabs.
for x in [-1.61,-1.45]:cube('Information substrate registration pad',(x,-.029,.53),(.014,.009,.038),gold,.002)

# Lower-right circular service detail with a slanted slotted rail, seen under haze.
px,pz=face_point(1312,923)
for radius,depth,mat in [(.145,-.070,optical_edge),(.120,-.065,core),(.083,-.072,optical_edge)]:
    torus('Moulded service socket',px,pz,radius,.0055,mat,depth).scale.z=.45
annular_profile('Moulded service socket center',px,pz,[(.021,-.040),(.043,-.040),(.048,-.060),(.035,-.074),(.021,-.068)],gold,32)
for i in range(11):
    x=1.03+i*.063
    channel('Moulded diagonal vent',[(x-.035,.38),(x+.030,.53)],-.075,.008,optical_edge)
    channel('Moulded diagonal vent recess',[(x-.029,.38),(x+.036,.53)],-.071,.003,core)
